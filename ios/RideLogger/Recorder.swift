import Combine
import CoreBluetooth
import CoreLocation
import Foundation

/// Automatic ride logging, same rules as the web app's RecorderProvider:
/// a ride starts when the engine starts and is saved when the power goes (adapter disconnects
/// or the ECU goes silent), or after the engine has been off for a while with the ignition on.
@MainActor
final class Recorder: ObservableObject {
    enum Phase { case idle, waiting, recording }
    enum LinkState { case none, connecting, connected, reconnecting }
    struct SavedRide { let id: String; let start: Date; let end: Date; let distanceKm: Double }

    @Published private(set) var link: LinkState = .none
    @Published private(set) var ecuOk = false
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var rideStartedAt: Date?
    @Published private(set) var live = Sample()
    @Published private(set) var stats = Totals()
    @Published private(set) var dtcs: [String]?
    @Published private(set) var lastSaved: SavedRide?
    @Published var vehicle = UserDefaults.standard.string(forKey: "vehicle-name") ?? "Suzuki Access 125" {
        didSet { UserDefaults.standard.set(vehicle, forKey: "vehicle-name") }
    }

    let bluetooth = BluetoothManager()
    let location = LocationTracker()
    let queue = UploadQueue()

    private struct ActiveRide {
        let base: [String: Any]
        var id: String { base["id"] as! String }
        var rows: [Reading] = []
        let manual: Bool
        var lastRunningAt = Date()
    }

    private var forwarders: [AnyCancellable] = []
    private var elm: Elm327?
    private var ride: ActiveRide?
    private var loop: Task<Void, Never>?
    private var waitForEngineOff = false
    private var ecuSilentSince: Date?

    private static let sampleInterval: Duration = .seconds(1)
    // ECU stopped answering: ignition is off, so the ride is over.
    private static let ecuSilentLimit: TimeInterval = 10
    // ECU answering but RPM 0: engine off with ignition on (or stalled). Allow a restart.
    private static let engineOffLimit: TimeInterval = 60

    init() {
        // Views read the adapter, GPS and upload state through the recorder.
        forwarders = [
            bluetooth.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
            location.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
            queue.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
        ]
        bluetooth.onReady = { [weak self] link in self?.adapterReady(link) }
        bluetooth.onDisconnect = { [weak self] in self?.adapterLost() }
        if bluetooth.hasSavedAdapter {
            link = .reconnecting
            location.start(precise: false)
        }
        Task { [weak self] in
            while let self {
                await self.queue.flush()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    // MARK: - Adapter

    func choose(_ peripheral: CBPeripheral) {
        link = .connecting
        location.start(precise: false)
        bluetooth.choose(peripheral)
    }

    func forgetAdapter() {
        bluetooth.forget()
        if let ride, !ride.manual { endRide() }
        elm = nil
        ecuOk = false
        link = .none
        if ride == nil { location.stop() }
    }

    private func adapterReady(_ serial: ElmLink) {
        let elm = Elm327(link: serial)
        Task {
            do {
                try await elm.initialize()
            } catch {
                return // the adapter dropped again; iOS will reconnect
            }
            self.elm = elm
            link = .connected
            ecuSilentSince = nil
            dtcs = nil
            startLoop()
        }
    }

    private func adapterLost() {
        elm = nil
        ecuOk = false
        if bluetooth.hasSavedAdapter { link = .reconnecting }
        // Adapter lost power with the scooter: save the ride now.
        if let ride, !ride.manual { endRide() }
    }

    // MARK: - Rides

    /// Manual start, for GPS-only rides without the adapter.
    func startGpsRide() {
        guard ride == nil else { return }
        startRide(manual: true)
        startLoop()
    }

    func endRideNow() {
        guard let ride else { return }
        // Don't let an engine that is still running start a new ride straight away.
        if !ride.manual { waitForEngineOff = true }
        endRide()
    }

    private func startRide(manual: Bool) {
        let base: [String: Any] = [
            "id": UUID().uuidString.lowercased(),
            "vehicle_name": vehicle,
            "started_at": isoFormatter.string(from: Date()),
            "obd_connected": !manual,
        ]
        let new = ActiveRide(base: base, manual: manual)
        ride = new
        queue.queueRide(base)
        rideStartedAt = Date()
        stats = Totals()
        phase = .recording
        location.start(precise: true)
        let codes = dtcs
        Task {
            await queue.flush()
            if let codes, !codes.isEmpty {
                try? await SupabaseClient.shared.insert("fault_codes", rows: codes.map { ["ride_id": new.id, "code": $0] })
            }
        }
    }

    private func endRide() {
        guard let finished = ride else { return }
        ride = nil
        rideStartedAt = nil
        phase = elm != nil ? .waiting : .idle
        if bluetooth.hasSavedAdapter { location.start(precise: false) } else { location.stop() }

        guard let last = finished.rows.last else {
            // Nothing was logged (engine never really ran); drop the empty ride.
            queue.dropRide(id: finished.id)
            return
        }
        let totals = summarize(finished.rows)
        var row = finished.base.merging(totals.row) { _, new in new }
        row["ended_at"] = isoFormatter.string(from: last.ts)
        queue.queueRide(row)
        lastSaved = SavedRide(id: finished.id, start: finished.rows[0].ts, end: last.ts, distanceKm: totals.distanceKm)
        Task { await queue.flush() }
    }

    private func log(_ sample: Sample) {
        guard let current = ride else { return }
        let fix = location.latest.flatMap { $0.horizontalAccuracy >= 0 && Date().timeIntervalSince($0.timestamp) < 10 ? $0 : nil }
        let reading = Reading(
            rideId: current.id,
            ts: Date(),
            lat: fix?.coordinate.latitude,
            lon: fix?.coordinate.longitude,
            gpsSpeed: fix.flatMap { $0.speed >= 0 ? $0.speed * 3.6 : nil },
            sample: sample,
            manual: current.manual
        )
        ride?.rows.append(reading)
        queue.add(reading.row)
    }

    // MARK: - Polling loop

    private func startLoop() {
        guard loop == nil else { return }
        if ride == nil { phase = elm != nil ? .waiting : .idle }
        loop = Task {
            while elm != nil || ride != nil {
                let tickStart = ContinuousClock.now
                var sample = Sample()
                var engineOn = false

                if let elm {
                    if dtcs == nil { dtcs = await elm.readDtcs() ?? [] }
                    let result = await elm.poll()
                    sample = result.sample
                    ecuOk = result.ecuOk
                    engineOn = result.ecuOk && (sample.rpm ?? 0) > 0
                    ecuSilentSince = result.ecuOk ? nil : (ecuSilentSince ?? Date())
                    if !engineOn { waitForEngineOff = false }
                    if engineOn, ride == nil, !waitForEngineOff { startRide(manual: false) }
                }

                if let current = ride {
                    if current.manual || engineOn {
                        log(sample)
                        if engineOn { ride?.lastRunningAt = Date() }
                    } else {
                        let silent = ecuSilentSince.map { Date().timeIntervalSince($0) > Self.ecuSilentLimit } ?? false
                        if silent || Date().timeIntervalSince(current.lastRunningAt) > Self.engineOffLimit { endRide() }
                    }
                }

                live = sample
                if let ride { stats = summarize(ride.rows) }
                try? await Task.sleep(until: tickStart + Self.sampleInterval, clock: .continuous)
            }
            loop = nil
            if ride == nil { phase = elm != nil ? .waiting : .idle }
        }
    }
}
