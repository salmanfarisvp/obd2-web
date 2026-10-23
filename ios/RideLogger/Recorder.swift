import Combine
import CoreBluetooth
import CoreLocation
import Foundation
import UIKit

/// Automatic ride logging, same rules as the web app's RecorderProvider:
/// a ride starts when the engine starts and is saved when the power goes (adapter disconnects
/// or the ECU goes silent), or after the engine has been off for a while with the ignition on.
/// Rides are recorded to the phone (LocalStore) and uploaded whole when they end.
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
    let store = LocalStore.shared
    /// Readings queued by earlier versions of the app; drained, then unused.
    private let legacyQueue = UploadQueue()

    private struct ActiveRide {
        let id: String
        var rows: [Reading] = []
        let manual: Bool
        var lastRunningAt = Date()
        var lastLoggedAt = Date.distantPast
    }

    private var forwarders: [AnyCancellable] = []
    private var elm: Elm327?
    private var ride: ActiveRide?
    private var loop: Task<Void, Never>?
    private var waitForEngineOff = false
    private var ecuSilentSince: Date?

    private static let sampleInterval: TimeInterval = 1
    // ECU stopped answering: ignition is off, so the ride is over.
    private static let ecuSilentLimit: TimeInterval = 10
    // ECU answering but RPM 0: engine off with ignition on (or stalled). Allow a restart.
    private static let engineOffLimit: TimeInterval = 60

    var pendingCount: Int { store.pending.filter { !$0.recording }.count + legacyQueue.pendingCount }

    init() {
        // Views read the adapter, GPS and upload state through the recorder.
        forwarders = [
            bluetooth.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
            location.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
            store.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
            legacyQueue.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
        ]
        bluetooth.onReady = { [weak self] link in self?.adapterReady(link) }
        bluetooth.onDisconnect = { [weak self] in self?.adapterLost() }
        DiagLog.log("App launched")
        store.recoverInterrupted()
        if bluetooth.hasSavedAdapter {
            link = .reconnecting
            location.start(precise: false)
        }
        // Upload finished rides whenever there's something to send.
        Task { [weak self] in
            while let self {
                await self.legacyQueue.flush()
                await self.store.uploadFinished()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    func appPhaseChanged(active: Bool) {
        DiagLog.log(active ? "App in foreground" : "App in background\(phase == .recording ? " (recording)" : "")")
        if active { Task { await store.uploadFinished() } }
    }

    // MARK: - Adapter

    func choose(_ peripheral: CBPeripheral) {
        link = .connecting
        location.start(precise: false)
        bluetooth.choose(peripheral)
    }

    func forgetAdapter() {
        bluetooth.forget()
        if let ride, !ride.manual { endRide(reason: "adapter forgotten") }
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
                DiagLog.log("Adapter setup failed: \(error.localizedDescription)")
                return // the adapter dropped again; iOS will reconnect
            }
            DiagLog.log("Adapter connected")
            self.elm = elm
            link = .connected
            ecuSilentSince = nil
            dtcs = nil
            startLoop()
        }
    }

    private func adapterLost() {
        DiagLog.log("Adapter disconnected")
        elm = nil
        ecuOk = false
        if bluetooth.hasSavedAdapter { link = .reconnecting }
        // Adapter lost power with the scooter: save the ride now.
        if let ride, !ride.manual { endRide(reason: "adapter off") }
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
        endRide(reason: "ended by you")
    }

    private func startRide(manual: Bool) {
        let id = UUID().uuidString.lowercased()
        store.startRide([
            "id": id,
            "vehicle_name": vehicle,
            "started_at": isoFormatter.string(from: Date()),
            "obd_connected": !manual,
        ], faultCodes: dtcs)
        ride = ActiveRide(id: id, manual: manual)
        rideStartedAt = Date()
        stats = Totals()
        phase = .recording
        location.start(precise: true)
        DiagLog.log("Ride \(id.prefix(8)) started (\(manual ? "GPS only" : "engine on"))")
    }

    private func endRide(reason: String) {
        guard let finished = ride else { return }
        ride = nil
        rideStartedAt = nil
        phase = elm != nil ? .waiting : .idle
        if bluetooth.hasSavedAdapter { location.start(precise: false) } else { location.stop() }

        guard let last = finished.rows.last else {
            // Nothing was logged (engine never really ran); drop the empty ride.
            store.discard(id: finished.id)
            DiagLog.log("Ride \(finished.id.prefix(8)) dropped, no readings (\(reason))")
            return
        }
        let totals = summarize(finished.rows)
        store.finishRide(id: finished.id, totals: totals, endedAt: last.ts)
        lastSaved = SavedRide(id: finished.id, start: finished.rows[0].ts, end: last.ts, distanceKm: totals.distanceKm)
        let withGps = finished.rows.filter { $0.lat != nil }.count
        DiagLog.log("Ride \(finished.id.prefix(8)) ended (\(reason)): \(finished.rows.count) readings, "
            + "GPS on \(withGps * 100 / finished.rows.count)%, \(fmt(totals.distanceKm, 2)) km")
        Task { await store.uploadFinished() }
    }

    private func log(_ sample: Sample) {
        guard let current = ride else { return }
        let now = Date()
        // Gaps over a few seconds mean the app wasn't running; worth knowing about.
        if let prev = current.rows.last, now.timeIntervalSince(prev.ts) > 5 {
            DiagLog.log("Logging gap of \(Int(now.timeIntervalSince(prev.ts)))s")
        }
        let fix = location.latest.flatMap { $0.horizontalAccuracy >= 0 && now.timeIntervalSince($0.timestamp) < 10 ? $0 : nil }
        let reading = Reading(
            rideId: current.id,
            ts: now,
            lat: fix?.coordinate.latitude,
            lon: fix?.coordinate.longitude,
            gpsSpeed: fix.flatMap { $0.speed >= 0 ? $0.speed * 3.6 : nil },
            sample: sample,
            manual: current.manual
        )
        ride?.rows.append(reading)
        ride?.lastLoggedAt = now
        store.append(reading)
    }

    // MARK: - Polling loop

    private func startLoop() {
        guard loop == nil else { return }
        if ride == nil { phase = elm != nil ? .waiting : .idle }
        loop = Task {
            var wasSilent = false
            while elm != nil || ride != nil {
                let tickStart = Date()
                var sample = Sample()
                var engineOn = false

                if let elm {
                    if dtcs == nil { dtcs = await elm.readDtcs() ?? [] }
                    let result = await elm.poll()
                    sample = result.sample
                    ecuOk = result.ecuOk
                    engineOn = result.ecuOk && (sample.rpm ?? 0) > 0
                    ecuSilentSince = result.ecuOk ? nil : (ecuSilentSince ?? Date())
                    if result.ecuOk == wasSilent {
                        wasSilent = !result.ecuOk
                        DiagLog.log(result.ecuOk ? "ECU answering" : "ECU not answering")
                    }
                    if !engineOn { waitForEngineOff = false }
                    if engineOn, ride == nil, !waitForEngineOff { startRide(manual: false) }
                }

                if let current = ride {
                    if current.manual || engineOn {
                        if Date().timeIntervalSince(current.lastLoggedAt) >= Self.sampleInterval * 0.9 { log(sample) }
                        if engineOn { ride?.lastRunningAt = Date() }
                    } else {
                        let silent = ecuSilentSince.map { Date().timeIntervalSince($0) > Self.ecuSilentLimit } ?? false
                        if silent { endRide(reason: "ECU silent") }
                        else if Date().timeIntervalSince(current.lastRunningAt) > Self.engineOffLimit { endRide(reason: "engine off") }
                    }
                }

                live = sample
                if let ride { stats = summarize(ride.rows) }
                location.checkHealth()

                // In the background, go straight to the next request instead of sleeping: each adapter
                // reply wakes the app, so polling keeps going even if iOS tries to suspend it. A sleep
                // timer would not fire while suspended. Rows are still logged at most once a second.
                let inBackground = UIApplication.shared.applicationState == .background
                let wait = Self.sampleInterval - Date().timeIntervalSince(tickStart)
                if elm != nil, ride != nil, inBackground {
                    await Task.yield()
                } else if wait > 0 {
                    try? await Task.sleep(for: .milliseconds(Int(wait * 1000)))
                }
            }
            loop = nil
            if ride == nil { phase = elm != nil ? .waiting : .idle }
        }
    }
}
