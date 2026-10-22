import Foundation
import Security

/// Website the app links to for ride history.
let webURL = URL(string: "https://obd2-web.vercel.app")!

struct AuthSession: Codable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
    var userId: String
    var email: String?
}

enum SupabaseError: LocalizedError {
    case http(Int, String)
    case notSignedIn

    var errorDescription: String? {
        switch self {
        case .http(_, let message): return message
        case .notSignedIn: return "Not signed in"
        }
    }
}

/// Minimal Supabase client over its REST API: password sign-in, token refresh and table writes.
/// Uses the same project and accounts as the website.
@MainActor
final class SupabaseClient: ObservableObject {
    static let shared = SupabaseClient()

    @Published private(set) var session: AuthSession?
    private let keychainKey = "supabase-session"

    private init() {
        session = Keychain.load(keychainKey).flatMap { try? JSONDecoder().decode(AuthSession.self, from: $0) }
    }

    func signIn(email: String, password: String) async throws {
        let data = try await send("auth/v1/token?grant_type=password", body: json(["email": email, "password": password]), token: nil)
        try storeSession(data)
    }

    func signOut() {
        session = nil
        Keychain.delete(keychainKey)
    }

    /// Insert rows (an array of JSON objects). With `upsert`, rows whose primary key exists are updated.
    func insert(_ table: String, rows: [[String: Any]], upsert: Bool = false) async throws {
        var prefer = "return=minimal"
        if upsert { prefer += ",resolution=merge-duplicates" }
        try await send("rest/v1/\(table)", body: json(rows), token: try await validToken(), headers: ["Prefer": prefer])
    }

    func delete(_ table: String, id: String) async throws {
        try await send("rest/v1/\(table)?id=eq.\(id)", method: "DELETE", token: try await validToken())
    }

    // MARK: - Private

    private func validToken() async throws -> String {
        guard let current = session else { throw SupabaseError.notSignedIn }
        if current.expiresAt > Date() { return current.accessToken }
        do {
            let data = try await send("auth/v1/token?grant_type=refresh_token", body: json(["refresh_token": current.refreshToken]), token: nil)
            try storeSession(data)
        } catch SupabaseError.http(let status, let message) where status == 400 || status == 401 {
            // Refresh token revoked or expired: the user has to sign in again.
            signOut()
            throw SupabaseError.http(status, message)
        }
        return session!.accessToken
    }

    private func storeSession(_ data: Data) throws {
        struct Response: Decodable {
            struct User: Decodable { let id: String; let email: String? }
            let access_token: String
            let refresh_token: String
            let expires_in: Double
            let user: User
        }
        let r = try JSONDecoder().decode(Response.self, from: data)
        let s = AuthSession(
            accessToken: r.access_token,
            refreshToken: r.refresh_token,
            expiresAt: Date().addingTimeInterval(r.expires_in - 60),
            userId: r.user.id,
            email: r.user.email
        )
        session = s
        Keychain.save(keychainKey, try JSONEncoder().encode(s))
    }

    private func json(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    @discardableResult
    private func send(_ path: String, method: String = "POST", body: Data? = nil, token: String?, headers: [String: String] = [:]) async throws -> Data {
        var req = URLRequest(url: URL(string: "\(Secrets.supabaseURL)/\(path)")!)
        req.httpMethod = method
        req.httpBody = body
        req.timeoutInterval = 20
        req.setValue(Secrets.supabaseKey, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }

        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = (obj?["msg"] ?? obj?["message"] ?? obj?["error_description"] ?? obj?["error"]) as? String
            throw SupabaseError.http(status, message ?? "Request failed (\(status))")
        }
        return data
    }
}

/// Stores the session in the Keychain so it survives app restarts.
enum Keychain {
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
    }

    static func save(_ key: String, _ data: Data) {
        SecItemDelete(query(key) as CFDictionary)
        var q = query(key)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock // readable while locked in the background
        SecItemAdd(q as CFDictionary, nil)
    }

    static func load(_ key: String) -> Data? {
        var q = query(key)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func delete(_ key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }
}
