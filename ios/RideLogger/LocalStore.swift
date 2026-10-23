import Foundation

/// Rides are recorded to the phone first and uploaded in one go when they end.
///
/// Each ride is two files: `<id>.json` (the ride row, plus local state) and `<id>.jsonl`
/// (one reading per line, appended the moment it's logged). Nothing is lost if iOS stops the
/// app mid-ride: on the next launch the ride is finished from its saved readings. A ride's
/// files are deleted only after Supabase has confirmed the whole ride.
@MainActor
final class LocalStore: ObservableObject {
    static let shared = LocalStore()

    /// Rides on the phone that aren't fully uploaded yet, newest first.
    @Published private(set) var pending: [RideRecord] = []
    @Published private(set) var uploading = false

    nonisolated static let directory: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("rides", isDirectory: true)
        // Readable while the phone is locked (after the first unlock since boot).
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return dir
    }()

    nonisolated static func create(_ url: URL, contents: Data) {
        FileManager.default.createFile(atPath: url.path, contents: contents,
                                       attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    }

    private static let chunkSize = 500
    private var client: SupabaseClient { SupabaseClient.shared }
    private var handles: [String: FileHandle] = [:]

    private init() {
        refreshPending()
    }

    private func metaURL(_ id: String) -> URL { Self.directory.appendingPathComponent("\(id).json") }
    private func readingsURL(_ id: String) -> URL { Self.directory.appendingPathComponent("\(id).jsonl") }

    // MARK: Recording

    func startRide(_ base: [String: Any], faultCodes: [String]?) {
        let id = base["id"] as! String
        var meta = base
        meta["local_state"] = "recording"
        if let faultCodes { meta["local_fault_codes"] = faultCodes }
        writeMeta(id, meta)
        Self.create(readingsURL(id), contents: Data())
        refreshPending()
    }

    func append(_ reading: Reading) {
        let id = reading.rideId
        guard var line = try? JSONSerialization.data(withJSONObject: reading.row) else { return }
        line.append(0x0A)
        if handles[id] == nil { handles[id] = try? FileHandle(forWritingTo: readingsURL(id)) }
        guard let handle = handles[id] else { return }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: line)
    }

    func finishRide(id: String, totals: Totals, endedAt: Date) {
        closeHandle(id)
        guard var meta = readMeta(id) else { return }
        meta.merge(totals.row) { _, new in new }
        meta["ended_at"] = isoFormatter.string(from: endedAt)
        meta["local_state"] = "ready"
        writeMeta(id, meta)
        refreshPending()
    }

    func discard(id: String) {
        closeHandle(id)
        try? FileManager.default.removeItem(at: metaURL(id))
        try? FileManager.default.removeItem(at: readingsURL(id))
        refreshPending()
    }

    /// Finish rides that were still recording when the app was stopped. Call at launch.
    func recoverInterrupted() {
        for id in rideIds() where readMeta(id)?["local_state"] as? String == "recording" {
            let rows = readings(id)
            if let last = rows.last {
                finishRide(id: id, totals: summarize(rows), endedAt: last.ts)
                DiagLog.log("Recovered interrupted ride \(id.prefix(8)) with \(rows.count) readings")
            } else {
                discard(id: id)
            }
        }
    }

    // MARK: Reading back (History tab)

    func readings(_ id: String) -> [Reading] {
        guard let data = try? Data(contentsOf: readingsURL(id)) else { return [] }
        return data.split(separator: 0x0A).compactMap { line in
            (try? JSONSerialization.jsonObject(with: line) as? [String: Any]).flatMap { Reading(row: $0) }
        }
    }

    func faultCodes(_ id: String) -> [String] {
        readMeta(id)?["local_fault_codes"] as? [String] ?? []
    }

    func setNote(id: String, note: String?) {
        guard var meta = readMeta(id) else { return }
        meta["note"] = note ?? NSNull()
        writeMeta(id, meta)
        refreshPending()
    }

    func isPending(_ id: String) -> Bool {
        FileManager.default.fileExists(atPath: metaURL(id).path)
    }

    // MARK: Upload

    /// Upload every finished ride. Each ride is sent whole (ride row, then readings in chunks,
    /// then fault codes) and removed from the phone only when all of it succeeded. A failed ride
    /// is retried next time and doesn't hold up the others.
    func uploadFinished() async {
        guard !uploading, client.session != nil else { return }
        uploading = true
        defer {
            uploading = false
            refreshPending()
        }
        for id in rideIds() {
            guard var meta = readMeta(id), meta["local_state"] as? String == "ready" else { continue }
            let codes = meta["local_fault_codes"] as? [String] ?? []
            meta["local_state"] = nil
            meta["local_fault_codes"] = nil
            let rows = readings(id).map(\.row)
            do {
                try await client.insert("rides", rows: [meta], upsert: true)
                // Start clean so a retry after a partial upload doesn't duplicate readings.
                try await client.delete("readings", column: "ride_id", equals: id)
                var sent = 0
                while sent < rows.count {
                    // PostgREST needs every row in a bulk insert to have the same columns (fuel_level is optional).
                    let columns = rows[sent].count
                    let chunk = Array(rows[sent...].prefix(Self.chunkSize).prefix { $0.count == columns })
                    try await client.insert("readings", rows: chunk)
                    sent += chunk.count
                }
                if !codes.isEmpty {
                    try await client.delete("fault_codes", column: "ride_id", equals: id)
                    try await client.insert("fault_codes", rows: codes.map { ["ride_id": id, "code": $0] })
                }
                discard(id: id)
                DiagLog.log("Uploaded ride \(id.prefix(8)): \(rows.count) readings")
            } catch {
                DiagLog.log("Upload of ride \(id.prefix(8)) failed, will retry: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Files

    private func rideIds() -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: Self.directory.path)) ?? []
        return files.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }
    }

    private func readMeta(_ id: String) -> [String: Any]? {
        guard let data = try? Data(contentsOf: metaURL(id)) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func writeMeta(_ id: String, _ meta: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: meta) else { return }
        Self.create(metaURL(id), contents: data)
    }

    private func closeHandle(_ id: String) {
        try? handles[id]?.close()
        handles[id] = nil
    }

    private func refreshPending() {
        pending = rideIds().compactMap { id -> RideRecord? in
            guard let meta = readMeta(id), var ride = RideRecord(meta) else { return nil }
            ride.pending = true
            ride.recording = meta["local_state"] as? String == "recording"
            return ride
        }
        .sorted { $0.startedAt > $1.startedAt }
    }
}
