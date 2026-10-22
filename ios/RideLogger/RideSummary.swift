import Foundation

/// One logged moment of a ride; field names match the `readings` table.
struct Reading {
    var rideId: String
    var ts: Date
    var lat: Double?
    var lon: Double?
    var gpsSpeed: Double?
    var sample: Sample
    var manual: Bool

    var rpm: Double? { manual ? nil : sample.rpm }
    var speed: Double? { manual ? nil : sample.speed }

    var row: [String: Any] {
        func v(_ x: Double?) -> Any { x ?? NSNull() }
        var row: [String: Any] = [
            "ride_id": rideId,
            "ts": isoFormatter.string(from: ts),
            "lat": v(lat), "lon": v(lon), "gps_speed": v(gpsSpeed),
            "rpm": v(rpm), "speed": v(speed),
            "coolant": v(sample.coolant), "intake_temp": v(sample.intakeTemp),
            "throttle": v(sample.throttle), "load": v(sample.load), "map_kpa": v(sample.mapKpa),
            "timing": v(sample.timing), "stft": v(sample.stft), "ltft": v(sample.ltft),
            "voltage": v(sample.voltage), "fuel_rate": v(sample.fuelRate),
        ]
        // Only sent when the ECU reports it, so uploads work before the fuel_level column exists.
        if let level = sample.fuelLevel { row["fuel_level"] = level }
        return row
    }
}

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

struct Totals {
    var distanceKm = 0.0
    var durationS = 0.0
    var avgSpeed = 0.0
    var maxSpeed = 0.0
    var maxRpm: Double?
    var maxCoolant: Double?
    var fuelL: Double?
    var movingS = 0.0
    var idleS = 0.0
    var stops = 0

    var row: [String: Any] {
        func v(_ x: Double?) -> Any { x ?? NSNull() }
        return [
            "distance_km": distanceKm, "duration_s": Int(durationS.rounded()), "avg_speed": avgSpeed,
            "max_speed": maxSpeed, "max_rpm": v(maxRpm), "max_coolant": v(maxCoolant), "fuel_l": v(fuelL),
            "moving_s": Int(movingS.rounded()), "idle_s": Int(idleS.rounded()), "stops": stops,
        ]
    }
}

// Same rules as lib/rideSummary.ts in the web app.
private let maxStepS = 5.0
private let movingKmh = 2.0
private let stopMinS = 5.0

func haversineKm(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
    let r = Double.pi / 180
    let dLat = (lat2 - lat1) * r
    let dLon = (lon2 - lon1) * r
    let a = sin(dLat / 2) * sin(dLat / 2) + cos(lat1 * r) * cos(lat2 * r) * sin(dLon / 2) * sin(dLon / 2)
    return 6371 * 2 * asin(sqrt(a))
}

func summarize(_ readings: [Reading]) -> Totals {
    var t = Totals()
    guard let first = readings.first, let last = readings.last else { return t }
    var obdKm = 0.0, gpsKm = 0.0, fuel = 0.0, maxRpm = 0.0, maxCoolant = 0.0
    var stillS = 0.0, hasMoved = false
    var prevGps: Reading?

    for (i, r) in readings.enumerated() {
        let speed = r.speed ?? r.gpsSpeed ?? 0
        t.maxSpeed = max(t.maxSpeed, speed)
        maxRpm = max(maxRpm, r.rpm ?? 0)
        maxCoolant = max(maxCoolant, r.sample.coolant ?? 0)
        if i > 0 {
            let dt = min(r.ts.timeIntervalSince(readings[i - 1].ts), maxStepS)
            if let s = r.speed { obdKm += s * dt / 3600 }
            fuel += (r.sample.fuelRate ?? 0) * dt / 3600
            // Engine off (RPM 0) counts as neither riding nor idling. GPS-only rides have no RPM.
            let engineOn = r.rpm == nil || r.rpm! > 0
            if speed > movingKmh {
                t.movingS += dt
                hasMoved = true
                stillS = 0
            } else if engineOn {
                t.idleS += dt
                if hasMoved, stillS < stopMinS, stillS + dt >= stopMinS { t.stops += 1 }
                stillS += dt
            }
        }
        if let lat = r.lat, let lon = r.lon {
            if let p = prevGps, let plat = p.lat, let plon = p.lon {
                let km = haversineKm(plat, plon, lat, lon)
                let hours = r.ts.timeIntervalSince(p.ts) / 3600
                if hours > 0, km / hours < 150 { gpsKm += km } // skip GPS jumps
            }
            prevGps = r
        }
    }
    t.durationS = last.ts.timeIntervalSince(first.ts)
    t.distanceKm = obdKm > 0 ? obdKm : gpsKm
    t.avgSpeed = t.durationS > 0 ? t.distanceKm / (t.durationS / 3600) : 0
    t.maxRpm = maxRpm > 0 ? maxRpm : nil
    t.maxCoolant = maxCoolant > 0 ? maxCoolant : nil
    t.fuelL = fuel > 0 ? fuel : nil
    return t
}
