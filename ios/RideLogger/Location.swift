import CoreLocation
import Foundation

/// Phone GPS. Kept running while an adapter is set up: precise during a ride, coarse (and cheap)
/// otherwise. Continuous location updates are also what lets iOS keep the app running with the
/// screen locked, so this checks that updates really arrive and restarts them if they stop.
@MainActor
final class LocationTracker: NSObject, ObservableObject {
    /// Why rides may not record properly with the screen locked; nil when all is well.
    enum Problem: Equatable {
        case notAllowed, notDecided, approximate, noUpdates

        var message: String {
            switch self {
            case .notAllowed: return "Location is off for Ride Logger. Rides will stop when the phone locks and have no route."
            case .notDecided: return "Allow location for Ride Logger, or rides will stop when the phone locks."
            case .approximate: return "Precise Location is off. Routes will be missing or rough."
            case .noUpdates: return "GPS isn't sending updates. Rides may stop when the phone locks."
            }
        }
    }

    @Published private(set) var latest: CLLocation?
    @Published private(set) var status: CLAuthorizationStatus
    @Published private(set) var preciseAllowed = true
    @Published private(set) var lastUpdateAt: Date?

    private let manager = CLLocationManager()
    private var wanted = false
    private var precise = false
    private var startedAt: Date?
    private var background: CLBackgroundActivitySession?
    private var askedForAlways = UserDefaults.standard.bool(forKey: "asked-location-always")

    override init() {
        status = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        preciseAllowed = manager.accuracyAuthorization == .fullAccuracy
    }

    var problem: Problem? {
        switch status {
        case .denied, .restricted: return .notAllowed
        case .notDetermined: return wanted ? .notDecided : nil
        default: break
        }
        if !preciseAllowed { return .approximate }
        if wanted, let since = lastUpdateAt ?? startedAt, Date().timeIntervalSince(since) > 60 { return .noUpdates }
        return nil
    }

    var hasAlways: Bool { status == .authorizedAlways }

    func start(precise: Bool) {
        let changed = !wanted || self.precise != precise
        wanted = true
        self.precise = precise
        manager.desiredAccuracy = precise ? kCLLocationAccuracyBest : kCLLocationAccuracyThreeKilometers
        manager.distanceFilter = precise ? kCLDistanceFilterNone : 500
        if changed { DiagLog.log("GPS wanted (\(precise ? "precise" : "coarse")), permission \(describe(status))") }
        switch status {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            begin()
        default:
            break
        }
    }

    func stop() {
        guard wanted else { return }
        wanted = false
        manager.stopUpdatingLocation()
        background?.invalidate()
        background = nil
        startedAt = nil
        DiagLog.log("GPS stopped")
    }

    /// Called every second by the recorder: restart GPS if it has gone quiet.
    func checkHealth() {
        guard wanted, status == .authorizedWhenInUse || status == .authorizedAlways else { return }
        // Coarse mode with a distance filter legitimately goes quiet while parked.
        let limit: TimeInterval = precise ? 20 : 600
        if let since = lastUpdateAt ?? startedAt, Date().timeIntervalSince(since) > limit {
            DiagLog.log("GPS silent for \(Int(Date().timeIntervalSince(since)))s, restarting")
            manager.stopUpdatingLocation()
            startedAt = nil
            begin()
        }
    }

    private func begin() {
        if startedAt == nil { startedAt = Date() }
        // iOS 17: keeps When-In-Use location sessions alive in the background.
        if background == nil { background = CLBackgroundActivitySession() }
        manager.startUpdatingLocation()
    }

    private func describe(_ s: CLAuthorizationStatus) -> String {
        switch s {
        case .authorizedAlways: return "Always"
        case .authorizedWhenInUse: return "While Using"
        case .denied: return "Denied"
        case .restricted: return "Restricted"
        case .notDetermined: return "Not decided"
        @unknown default: return "Unknown"
        }
    }
}

extension LocationTracker: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        MainActor.assumeIsolated {
            guard let last = locations.last else { return }
            if lastUpdateAt == nil || Date().timeIntervalSince(lastUpdateAt!) > 30 {
                DiagLog.log("GPS updates flowing (±\(Int(last.horizontalAccuracy)) m)")
            }
            latest = last
            lastUpdateAt = Date()
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            status = manager.authorizationStatus
            preciseAllowed = manager.accuracyAuthorization == .fullAccuracy
            DiagLog.log("Location permission: \(describe(status))\(preciseAllowed ? "" : ", approximate only")")
            guard wanted else { return }
            if status == .authorizedWhenInUse || status == .authorizedAlways { begin() }
            // Ask once to upgrade to Always: iOS can then relaunch the app for location if it was closed.
            if status == .authorizedWhenInUse, !askedForAlways {
                askedForAlways = true
                UserDefaults.standard.set(true, forKey: "asked-location-always")
                manager.requestAlwaysAuthorization()
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        MainActor.assumeIsolated {
            DiagLog.log("GPS error: \(error.localizedDescription)")
        }
    }
}
