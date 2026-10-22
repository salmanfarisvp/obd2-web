import CoreLocation
import Foundation

/// Phone GPS. Kept running while an adapter is set up: precise during a ride, coarse (and cheap)
/// otherwise. Continuous location updates are also what lets iOS keep the app running with the
/// screen locked.
@MainActor
final class LocationTracker: NSObject, ObservableObject {
    @Published private(set) var latest: CLLocation?
    @Published private(set) var authorized = false
    private let manager = CLLocationManager()
    private var running = false

    override init() {
        super.init()
        manager.delegate = self
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        #if os(iOS)
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        #endif
    }

    func start(precise: Bool) {
        manager.desiredAccuracy = precise ? kCLLocationAccuracyBest : kCLLocationAccuracyThreeKilometers
        manager.distanceFilter = precise ? kCLDistanceFilterNone : 500
        if manager.authorizationStatus == .notDetermined { manager.requestAlwaysAuthorization() }
        if !running {
            manager.startUpdatingLocation()
            running = true
        }
    }

    func stop() {
        manager.stopUpdatingLocation()
        running = false
    }
}

extension LocationTracker: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        MainActor.assumeIsolated {
            if let last = locations.last { latest = last }
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            let status = manager.authorizationStatus
            #if os(iOS)
            authorized = status == .authorizedAlways || status == .authorizedWhenInUse
            #else
            authorized = status == .authorizedAlways
            #endif
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
