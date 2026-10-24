import Foundation

/// A row of the `rides` table.
struct RideRecord: Identifiable {
    let id: String
    var vehicleName: String
    var startedAt: Date
    var endedAt: Date?
    var distanceKm: Double?
    var durationS: Double?
    var avgSpeed: Double?
    var maxSpeed: Double?
    var maxRpm: Double?
    var maxCoolant: Double?
    var fuelL: Double?
    var movingS: Double?
    var idleS: Double?
    var stops: Int?
    var breaks: Int?
    var breakS: Double?
    var note: String?
    /// Still on the phone, not fully uploaded yet.
    var pending = false
    /// Being recorded right now.
    var recording = false

    init?(_ row: [String: Any]) {
        guard let id = row["id"] as? String, let started = parseDate(row["started_at"]) else { return nil }
        self.id = id
        vehicleName = row["vehicle_name"] as? String ?? ""
        startedAt = started
        endedAt = parseDate(row["ended_at"])
        distanceKm = num(row["distance_km"])
        durationS = num(row["duration_s"])
        avgSpeed = num(row["avg_speed"])
        maxSpeed = num(row["max_speed"])
        maxRpm = num(row["max_rpm"])
        maxCoolant = num(row["max_coolant"])
        fuelL = num(row["fuel_l"])
        movingS = num(row["moving_s"])
        idleS = num(row["idle_s"])
        stops = num(row["stops"]).map { Int($0) }
        breaks = num(row["breaks"]).map { Int($0) }
        breakS = num(row["break_s"])
        note = row["note"] as? String
    }

    /// Fill in totals from the readings for rides that were never stopped, like the website does.
    mutating func fillMissing(from readings: [Reading]) {
        guard endedAt == nil || movingS == nil || breaks == nil, !readings.isEmpty else { return }
        let t = summarize(readings)
        movingS = t.movingS
        idleS = t.idleS
        stops = t.stops
        breaks = t.breaks
        breakS = t.breakS
        if endedAt == nil {
            distanceKm = t.distanceKm
            durationS = t.durationS
            avgSpeed = t.avgSpeed
            maxSpeed = t.maxSpeed
            maxRpm = t.maxRpm
            maxCoolant = t.maxCoolant
            fuelL = t.fuelL
        }
    }
}

func num(_ value: Any?) -> Double? {
    (value as? NSNumber)?.doubleValue
}

/// Postgres timestamps come back with up to 6 fractional digits, which ISO8601DateFormatter rejects.
func parseDate(_ value: Any?) -> Date? {
    guard var s = value as? String else { return nil }
    if let dot = s.firstIndex(of: "."), let zone = s[dot...].firstIndex(where: { $0 == "+" || $0 == "-" || $0 == "Z" }) {
        let fraction = s[s.index(after: dot)..<zone]
        s.replaceSubrange(s.index(after: dot)..<zone, with: String(fraction.prefix(3)).padding(toLength: 3, withPad: "0", startingAt: 0))
    }
    return isoFormatter.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}

extension Reading {
    init?(row: [String: Any]) {
        guard let ts = parseDate(row["ts"]) else { return nil }
        var s = Sample()
        s.rpm = num(row["rpm"])
        s.speed = num(row["speed"])
        s.throttle = num(row["throttle"])
        s.mapKpa = num(row["map_kpa"])
        s.load = num(row["load"])
        s.coolant = num(row["coolant"])
        s.intakeTemp = num(row["intake_temp"])
        s.timing = num(row["timing"])
        s.stft = num(row["stft"])
        s.ltft = num(row["ltft"])
        s.voltage = num(row["voltage"])
        s.fuelRate = num(row["fuel_rate"])
        s.fuelLevel = num(row["fuel_level"])
        self.init(
            rideId: row["ride_id"] as? String ?? "",
            ts: ts,
            lat: num(row["lat"]),
            lon: num(row["lon"]),
            gpsSpeed: num(row["gps_speed"]),
            sample: s,
            manual: false
        )
    }

    /// Speed for display: OBD when logged, else GPS.
    var displaySpeed: Double? { sample.speed ?? gpsSpeed }
}

@MainActor
enum History {
    private static var client: SupabaseClient { SupabaseClient.shared }

    static func rides() async throws -> [RideRecord] {
        try await client.select("rides?select=*&order=started_at.desc").compactMap(RideRecord.init)
    }

    static func readings(rideId: String) async throws -> [Reading] {
        var all: [Reading] = []
        let page = 1000 // Supabase caps responses at 1000 rows by default
        while true {
            let rows = try await client.select("readings?select=*&ride_id=eq.\(rideId)&order=ts&limit=\(page)&offset=\(all.count)")
            all += rows.compactMap { Reading(row: $0) }
            if rows.count < page { return all }
        }
    }

    static func faultCodes(rideId: String) async throws -> [String] {
        try await client.select("fault_codes?select=code&ride_id=eq.\(rideId)").compactMap { $0["code"] as? String }
    }

    static func saveNote(rideId: String, note: String) async throws {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        try await client.update("rides", id: rideId, fields: ["note": trimmed.isEmpty ? NSNull() : trimmed])
    }

    static func delete(rideId: String) async throws {
        try await client.delete("rides", id: rideId)
    }

    /// Merge rides into the earliest one, like lib/merge.ts on the website: move the others' readings
    /// and fault codes over, recompute totals (the gaps become breaks), join notes, delete the empty rides.
    static func merge(_ rides: [RideRecord]) async throws -> RideRecord {
        let sorted = rides.sorted { $0.startedAt < $1.startedAt }
        var target = sorted[0]
        // Needs migration 004 (break columns); check before moving anything so a merge never half-happens.
        do {
            _ = try await client.select("rides?select=breaks&limit=1")
        } catch {
            throw SupabaseError.http(400, "Run supabase/migrations/004_breaks_and_merge.sql in Supabase first.")
        }
        for other in sorted.dropFirst() {
            try await client.update("readings", column: "ride_id", equals: other.id, fields: ["ride_id": target.id])
            try await client.update("fault_codes", column: "ride_id", equals: other.id, fields: ["ride_id": target.id])
        }
        let rows = try await readings(rideId: target.id)
        let totals = summarize(rows)
        let note = sorted.compactMap(\.note).filter { !$0.isEmpty }.joined(separator: " · ")
        var fields = totals.row
        fields["ended_at"] = rows.last.map { isoFormatter.string(from: $0.ts) } ?? NSNull()
        fields["note"] = note.isEmpty ? NSNull() : note
        try await client.update("rides", id: target.id, fields: fields)
        // Their readings now belong to the target, so this removes only the empty ride rows.
        for other in sorted.dropFirst() { try await client.delete("rides", id: other.id) }

        target.endedAt = rows.last?.ts ?? target.endedAt
        target.distanceKm = totals.distanceKm
        target.durationS = totals.durationS
        target.avgSpeed = totals.avgSpeed
        target.maxSpeed = totals.maxSpeed
        target.maxRpm = totals.maxRpm
        target.maxCoolant = totals.maxCoolant
        target.fuelL = totals.fuelL
        target.movingS = totals.movingS
        target.idleS = totals.idleS
        target.stops = totals.stops
        target.breaks = totals.breaks
        target.breakS = totals.breakS
        target.note = note.isEmpty ? nil : note
        return target
    }
}
