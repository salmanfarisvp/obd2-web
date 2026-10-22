import Foundation

/// Rides and readings waiting to be uploaded. Kept on disk so nothing is lost without signal
/// or if iOS stops the app. Rides go first because readings reference them.
@MainActor
final class UploadQueue: ObservableObject {
    @Published private(set) var pendingCount = 0

    private var rides: [String: (row: [String: Any], version: Int)] = [:]
    private var readings: [[String: Any]] = []
    private var version = 0
    private var flushing = false
    private let client = SupabaseClient.shared
    private let file: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("upload-queue.json")
    }()
    private static let batchSize = 500

    init() {
        load()
    }

    func queueRide(_ row: [String: Any]) {
        let id = row["id"] as! String
        version += 1
        rides[id] = (row: (rides[id]?.row ?? [:]).merging(row) { _, new in new }, version: version)
        save()
    }

    /// Forget a ride that never got any readings, locally and on the server.
    func dropRide(id: String) {
        rides[id] = nil
        save()
        Task { try? await client.delete("rides", id: id) }
    }

    func add(_ reading: [String: Any]) {
        readings.append(reading)
        pendingCount = rides.count + readings.count
    }

    func flush() async {
        guard !flushing, client.session != nil else { return }
        flushing = true
        defer {
            flushing = false
            save()
        }
        for (id, entry) in rides {
            do {
                try await client.insert("rides", rows: [entry.row], upsert: true)
                if rides[id]?.version == entry.version { rides[id] = nil }
            } catch {
                return
            }
        }
        while !readings.isEmpty {
            // PostgREST needs every row in a bulk insert to have the same columns (fuel_level is optional).
            let columns = readings[0].count
            let batch = Array(readings.prefix(Self.batchSize).prefix { $0.count == columns })
            do {
                try await client.insert("readings", rows: batch)
                readings.removeFirst(batch.count)
            } catch {
                return
            }
        }
    }

    private func save() {
        pendingCount = rides.count + readings.count
        let object: [String: Any] = ["rides": rides.mapValues { $0.row }, "readings": readings]
        if let data = try? JSONSerialization.data(withJSONObject: object) {
            try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    private func load() {
        guard let data = try? Data(contentsOf: file),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        for (id, row) in object["rides"] as? [String: [String: Any]] ?? [:] {
            version += 1
            rides[id] = (row: row, version: version)
        }
        readings = object["readings"] as? [[String: Any]] ?? []
        pendingCount = rides.count + readings.count
    }
}
