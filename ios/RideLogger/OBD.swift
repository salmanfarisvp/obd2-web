import Foundation

/// Latest engine values. Mirrors lib/obd/pids.ts in the web app.
struct Sample {
    var rpm: Double?
    var speed: Double?
    var throttle: Double?
    var mapKpa: Double?
    var load: Double?
    var coolant: Double?
    var intakeTemp: Double?
    var timing: Double?
    var stft: Double?
    var ltft: Double?
    var fuelLevel: Double?
    var voltage: Double?
    var fuelRate: Double?
}

struct Pid {
    let code: String
    let apply: (inout Sample, [Int]) -> Void
}

// Mode 01 PIDs reported by the Suzuki Access 125 ECU (CAN 11-bit, 500k, ECU 7E8).
enum Pids {
    static let rpm = Pid(code: "0C") { s, b in s.rpm = Double(b[0] * 256 + b[1]) / 4 }
    // Polled every cycle after RPM.
    static let fast: [Pid] = [
        Pid(code: "0D") { s, b in s.speed = Double(b[0]) },
        Pid(code: "11") { s, b in s.throttle = Double(b[0]) * 100 / 255 },
        Pid(code: "0B") { s, b in s.mapKpa = Double(b[0]) },
    ]
    // One of these per cycle.
    static let slow: [Pid] = [
        Pid(code: "04") { s, b in s.load = Double(b[0]) * 100 / 255 },
        Pid(code: "05") { s, b in s.coolant = Double(b[0]) - 40 },
        Pid(code: "0F") { s, b in s.intakeTemp = Double(b[0]) - 40 },
        Pid(code: "0E") { s, b in s.timing = Double(b[0]) / 2 - 64 },
        Pid(code: "06") { s, b in s.stft = Double(b[0]) * 100 / 128 - 100 },
        Pid(code: "07") { s, b in s.ltft = Double(b[0]) * 100 / 128 - 100 },
        // Probably unsupported on the Access 125; harmless to ask.
        Pid(code: "2F") { s, b in s.fuelLevel = Double(b[0]) * 100 / 255 },
    ]
    static let byteCount: [String: Int] = ["0C": 2]
}

/// Data bytes for "41 <pid>" in an ELM response (spaces and headers off), or nil if absent.
func parseMode01(_ raw: String, pid: String) -> [Int]? {
    let hex = raw.uppercased().filter { !$0.isWhitespace }
    guard let range = hex.range(of: "41" + pid) else { return nil }
    let rest = Array(hex[range.upperBound...])
    var bytes: [Int] = []
    var i = 0
    while i + 1 < rest.count, let value = Int(String(rest[i...i + 1]), radix: 16) {
        bytes.append(value)
        i += 2
    }
    return bytes.count >= (Pids.byteCount[pid] ?? 1) ? bytes : nil
}

/// Stored DTCs from a mode 03 response. Handles CAN single and multi-frame responses.
func parseDtcs(_ raw: String) -> [String] {
    let lines = raw.components(separatedBy: CharacterSet(charactersIn: "\r\n"))
        .map { line -> String in
            var l = line.trimmingCharacters(in: .whitespaces)
            if let colon = l.firstIndex(of: ":"), l.distance(from: l.startIndex, to: colon) == 1 {
                l = String(l[l.index(after: colon)...])
            }
            return l.filter { !$0.isWhitespace }.uppercased()
        }
        .filter { $0.count > 3 && $0.allSatisfy(\.isHexDigit) } // drop the multi-frame length line
    let hex = lines.joined()
    guard let start = hex.range(of: "43") else { return [] }
    let body = Array(hex[start.upperBound...].dropFirst(2)) // skip the count byte
    var codes: [String] = []
    var i = 0
    while i + 4 <= body.count {
        let word = String(body[i..<i + 4])
        i += 4
        guard word != "0000", let first = Int(String(word.first!), radix: 16) else { continue }
        let system = Array("PCBU")[first >> 2]
        codes.append("\(system)\(first & 3)\(word.dropFirst())")
    }
    return codes
}

/// Estimated fuel flow (L/h) using speed-density, since the ECU has no MAF sensor.
/// Defaults are for the Access 125: 124 cc single cylinder, ~85% volumetric efficiency.
func estimateFuelRate(rpm: Double, mapKpa: Double, iatC: Double, displacementCc: Double = 124, ve: Double = 0.85) -> Double {
    let airDensity = (mapKpa * 1000) / (287.05 * (iatC + 273.15)) // kg/m³
    let airPerIntake = airDensity * displacementCc * 1e-6 * ve * 1000 // g
    let airFlow = airPerIntake * (rpm / 120) // g/s, 4-stroke
    return ((airFlow / 14.7) / 745) * 3600 // L/h of petrol
}

/// ELM327 protocol on top of a Bluetooth serial link.
@MainActor
final class Elm327 {
    let link: ElmLink
    private var latest = Sample()
    private var slowIndex = 0

    init(link: ElmLink) {
        self.link = link
    }

    /// Set up the adapter for the scooter's CAN bus. The ECU may still be off; poll() reports that.
    func initialize() async throws {
        latest = Sample()
        for cmd in ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATAT1", "ATSP6"] {
            _ = try await link.send(cmd, timeout: cmd == "ATZ" ? 5 : 2)
        }
    }

    private func read(_ pid: Pid) async -> Bool {
        guard let raw = try? await link.send("01" + pid.code), let bytes = parseMode01(raw, pid: pid.code) else { return false }
        pid.apply(&latest, bytes)
        return true
    }

    /// One polling cycle. `ecuOk` is false when the ECU didn't answer for RPM (ignition off).
    func poll() async -> (sample: Sample, ecuOk: Bool) {
        let ecuOk = await read(Pids.rpm)
        guard ecuOk else { return (latest, false) }

        for pid in Pids.fast { _ = await read(pid) }
        let next = slowIndex % (Pids.slow.count + 1)
        slowIndex += 1
        if next == Pids.slow.count {
            if let raw = try? await link.send("ATRV"), let v = Double(raw.filter { $0.isNumber || $0 == "." }) {
                latest.voltage = v
            }
        } else {
            _ = await read(Pids.slow[next])
        }
        if let rpm = latest.rpm, let map = latest.mapKpa {
            latest.fuelRate = rpm > 0 ? estimateFuelRate(rpm: rpm, mapKpa: map, iatC: latest.intakeTemp ?? 30) : 0
        }
        return (latest, true)
    }

    func readDtcs() async -> [String]? {
        guard let raw = try? await link.send("03", timeout: 5) else { return nil }
        return parseDtcs(raw)
    }
}
