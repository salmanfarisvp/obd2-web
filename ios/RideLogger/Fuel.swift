import Foundation

// Profile, vehicles, fuel log and the mileage/cost maths. Mirrors lib/fuel.ts in the web app.

let defaultCurrency = "₹"

struct Profile {
    var currency: String
    var fuelPrice: Double?
    /// Rides restarting within this many minutes are merged; 0 turns it off.
    var mergeGapMin: Int = 10
}

struct Vehicle: Identifiable {
    let id: String
    var name: String
    var tankL: Double?
}

struct FuelLog: Identifiable {
    let id: String
    var vehicleName: String
    var filledAt: Date
    var litres: Double
    var amount: Double?
    var pricePerL: Double?
    var fullTank: Bool
    var source: String
    var note: String?

    init?(_ row: [String: Any]) {
        guard let id = row["id"] as? String, let at = parseDate(row["filled_at"]), let litres = num(row["litres"]) else { return nil }
        self.id = id
        vehicleName = row["vehicle_name"] as? String ?? ""
        filledAt = at
        self.litres = litres
        amount = num(row["amount"])
        pricePerL = num(row["price_per_l"])
        fullTank = row["full_tank"] as? Bool ?? false
        source = row["source"] as? String ?? "manual"
        note = row["note"] as? String
    }
}

struct Mileage {
    let kmPerL: Double
    let km: Double
    let litres: Double
    let fills: Int
    let full: Bool
    let confident: Bool
    /// Real fuel ÷ estimated fuel over the same rides; scales the engine-based estimates.
    let factor: Double?

    /// Correction for engine estimates, once the fuel log is reliable enough to trust it.
    var calibration: Double? { confident ? factor : nil }
}

func money(_ currency: String, _ value: Double) -> String {
    "\(currency)\(String(format: value >= 100 ? "%.0f" : "%.2f", value))"
}

@MainActor
final class FuelStore: ObservableObject {
    @Published private(set) var profile: Profile?
    @Published private(set) var vehicles: [Vehicle] = []
    @Published private(set) var logs: [FuelLog] = [] // oldest first
    @Published private(set) var rides: [RideRecord] = []
    @Published var error: String?

    private var client: SupabaseClient { SupabaseClient.shared }
    // Fill-ups (in tank-fulls) needed before partial-fill mileage is trusted.
    private static let confidentTanks = 3.0

    var currency: String { profile?.currency ?? defaultCurrency }

    func load() async {
        do {
            async let p = client.select("profiles?select=*")
            async let v = client.select("vehicles?select=*&order=name")
            async let l = client.select("fuel_logs?select=*&order=filled_at")
            async let r = History.rides()
            let (pRows, vRows, lRows, rideList) = try await (p, v, l, r)
            profile = pRows.first.map {
                Profile(currency: $0["currency"] as? String ?? defaultCurrency, fuelPrice: num($0["fuel_price"]),
                        mergeGapMin: num($0["merge_gap_min"]).map { Int($0) } ?? 10)
            }
            if let gap = profile?.mergeGapMin { UserDefaults.standard.set(gap, forKey: "merge-gap-min") }
            vehicles = vRows.compactMap { row in
                (row["id"] as? String).map { Vehicle(id: $0, name: row["name"] as? String ?? "", tankL: num(row["tank_l"])) }
            }
            logs = lRows.compactMap(FuelLog.init)
            rides = rideList
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Every vehicle name in use: from Profile, rides and fill-ups.
    func vehicleNames(including current: String) -> [String] {
        var names = [current]
        for n in vehicles.map(\.name) + rides.map(\.vehicleName) + logs.map(\.vehicleName) where !names.contains(n) {
            names.append(n)
        }
        return names
    }

    // MARK: Maths

    /// Petrol price for a moment: the latest fill-up price before it, else the profile price.
    func price(at date: Date) -> Double? {
        logs.last { $0.filledAt <= date && $0.pricePerL != nil }?.pricePerL ?? profile?.fuelPrice
    }

    /// Real mileage from the fuel log. Fuel bought between two fill-ups is what the rides between
    /// them burned. Full-to-full is exact; with partial fills the unknown tank level at each end
    /// blurs it by up to a tankful, so it needs a few tankfuls of history to be trustworthy.
    func mileage(for vehicle: String) -> Mileage? {
        let vLogs = logs.filter { $0.vehicleName == vehicle }
        let full = vLogs.filter(\.fullTank)
        let tank = vehicles.first { $0.name == vehicle }?.tankL ?? 5
        let useFull = full.count >= 2
        guard let start = useFull ? full.first : vLogs.first,
              let end = useFull ? full.last : vLogs.last,
              start.id != end.id else { return nil }

        let litres = vLogs.filter { $0.filledAt > start.filledAt && $0.filledAt <= end.filledAt }.reduce(0) { $0 + $1.litres }
        let between = rides.filter { $0.vehicleName == vehicle && $0.startedAt >= start.filledAt && $0.startedAt < end.filledAt }
        let km = between.reduce(0) { $0 + ($1.distanceKm ?? 0) }
        let estimated = between.reduce(0) { $0 + ($1.fuelL ?? 0) }
        guard km > 0, litres > 0 else { return nil }
        return Mileage(
            kmPerL: km / litres,
            km: km,
            litres: litres,
            fills: vLogs.filter { $0.filledAt >= start.filledAt && $0.filledAt <= end.filledAt }.count,
            full: useFull,
            confident: useFull || litres >= Self.confidentTanks * tank,
            factor: estimated > 0 ? litres / estimated : nil
        )
    }

    /// Fuel a ride used: the engine estimate (calibrated when possible), or real mileage alone for GPS-only rides.
    func fuel(for ride: RideRecord) -> Double? {
        let m = mileage(for: ride.vehicleName)
        if let f = ride.fuelL { return f * (m?.calibration ?? 1) }
        if let m, let km = ride.distanceKm, km > 0 { return km / m.kmPerL }
        return nil
    }

    func cost(for ride: RideRecord) -> Double? {
        guard let litres = fuel(for: ride), let price = price(at: ride.startedAt) else { return nil }
        return litres * price
    }

    // MARK: Writes

    func saveProfile(currency: String, fuelPrice: Double?, mergeGapMin: Int? = nil) async throws {
        guard let userId = client.session?.userId else { throw SupabaseError.notSignedIn }
        let gap = mergeGapMin ?? profile?.mergeGapMin ?? 10
        try await client.insert("profiles", rows: [["user_id": userId, "currency": currency, "fuel_price": fuelPrice ?? NSNull(),
                                                    "merge_gap_min": gap]], upsert: true)
        profile = Profile(currency: currency, fuelPrice: fuelPrice, mergeGapMin: gap)
        UserDefaults.standard.set(gap, forKey: "merge-gap-min")
    }

    /// Save a vehicle (new when `id` is nil). A rename carries over to its rides and fill-ups.
    func saveVehicle(id: String?, name: String, tankL: Double?, originalName: String?) async throws {
        var row: [String: Any] = ["name": name, "tank_l": tankL ?? NSNull()]
        if let id { row["id"] = id }
        _ = try await client.upsertReturning("vehicles", rows: [row])
        if let originalName, originalName != name {
            try await client.update("rides", column: "vehicle_name", equals: originalName, fields: ["vehicle_name": name])
            try await client.update("fuel_logs", column: "vehicle_name", equals: originalName, fields: ["vehicle_name": name])
        }
    }

    func deleteVehicle(id: String) async throws {
        try await client.delete("vehicles", id: id)
    }

    func addFillUp(vehicle: String, at date: Date, litres: Double, amount: Double?, price: Double?, fullTank: Bool, note: String?) async throws {
        try await client.insert("fuel_logs", rows: [[
            "vehicle_name": vehicle,
            "filled_at": isoFormatter.string(from: date),
            "litres": litres,
            "amount": amount ?? NSNull(),
            "price_per_l": price ?? NSNull(),
            "full_tank": fullTank,
            "source": "manual",
            "note": note ?? NSNull(),
        ]])
        // The newest fill-up's price becomes the current petrol price.
        if let price, !logs.contains(where: { $0.filledAt > date }) {
            try await saveProfile(currency: currency, fuelPrice: price)
        }
    }

    func deleteFillUp(id: String) async throws {
        try await client.delete("fuel_logs", id: id)
    }
}
