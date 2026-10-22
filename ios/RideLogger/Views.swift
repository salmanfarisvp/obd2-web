import CoreBluetooth
import SwiftUI

@main
struct RideLoggerApp: App {
    @StateObject private var client = SupabaseClient.shared
    @StateObject private var recorder = Recorder()
    @StateObject private var fuel = FuelStore()

    var body: some Scene {
        WindowGroup {
            Group {
                if client.session == nil {
                    LoginView()
                } else {
                    TabView {
                        MainView().tabItem { Label("Ride", systemImage: "scooter") }
                        RidesView().tabItem { Label("History", systemImage: "map") }
                        FuelView().tabItem { Label("Fuel", systemImage: "fuelpump") }
                        ProfileView().tabItem { Label("Profile", systemImage: "person.crop.circle") }
                    }
                }
            }
            .environmentObject(client)
            .environmentObject(recorder)
            .environmentObject(fuel)
            .preferredColorScheme(.dark)
        }
    }
}

struct LoginView: View {
    @EnvironmentObject private var client: SupabaseClient
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $email).emailInput()
                    SecureField("Password", text: $password)
                } footer: {
                    Text("Use the same account as the website.")
                }
                Section {
                    Button(busy ? "Signing in…" : "Sign in") { signIn() }
                        .disabled(busy || email.isEmpty || password.isEmpty)
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .navigationTitle("🛵 Ride Logger")
        }
    }

    private func signIn() {
        busy = true
        error = nil
        Task {
            do {
                try await client.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

struct MainView: View {
    @EnvironmentObject private var client: SupabaseClient
    @EnvironmentObject private var recorder: Recorder
    @State private var picking = false

    var body: some View {
        NavigationStack {
            List {
                statusSection
                if recorder.link == .connected || recorder.phase == .recording { liveSection }
                if recorder.phase == .recording { rideSection }
                if let saved = recorder.lastSaved, recorder.phase != .recording { lastRideSection(saved) }
                if let dtcs = recorder.dtcs { faultSection(dtcs) }
            }
            .navigationTitle("🛵 Ride Logger")
            .sheet(isPresented: $picking) { AdapterPicker(isPresented: $picking) }
        }
    }

    private var statusText: String {
        switch (recorder.phase, recorder.link) {
        case (.recording, _):
            return "Recording since \(recorder.rideStartedAt!.formatted(date: .omitted, time: .shortened))"
        case (_, .connected):
            return recorder.ecuOk ? "Ready. The ride starts when the engine starts." : "Adapter connected. Turn the ignition on."
        case (_, .connecting):
            return "Connecting…"
        case (_, .reconnecting):
            return "Waiting for the adapter. It connects by itself when the scooter is switched on."
        default:
            return "Choose your adapter once; rides then start and save automatically, even with the phone locked."
        }
    }

    private var statusSection: some View {
        Section {
            HStack {
                Pill(text: adapterLabel, color: recorder.link == .connected ? .green : recorder.link == .reconnecting ? .orange : .gray)
                if let fix = recorder.location.latest {
                    Pill(text: "GPS ±\(Int(fix.horizontalAccuracy)) m", color: fix.horizontalAccuracy <= 30 ? .green : .orange)
                } else {
                    Pill(text: "GPS waiting", color: .gray)
                }
                if recorder.queue.pendingCount > 0 {
                    Pill(text: "\(recorder.queue.pendingCount) unsent", color: .orange)
                }
            }
            Text(statusText)
            if recorder.phase != .recording {
                TextField("Vehicle", text: $recorder.vehicle)
            }
            if recorder.phase == .recording {
                Button("End ride now", role: .destructive) { recorder.endRideNow() }
            } else {
                Button(recorder.bluetooth.hasSavedAdapter ? "Change adapter" : "Choose adapter") { picking = true }
                if recorder.bluetooth.hasSavedAdapter {
                    Button("Forget adapter", role: .destructive) { recorder.forgetAdapter() }
                } else {
                    Button("Start GPS-only ride") { recorder.startGpsRide() }
                }
            }
        }
    }

    private var adapterLabel: String {
        let name = recorder.bluetooth.savedName ?? "Adapter"
        switch recorder.link {
        case .connected: return "● \(name)"
        case .reconnecting: return "● \(name) off"
        case .connecting: return "Connecting…"
        case .none: return "OBD not connected"
        }
    }

    private var liveSection: some View {
        let s = recorder.live
        let gpsKmh = recorder.location.latest.flatMap { $0.speed >= 0 ? $0.speed * 3.6 : nil }
        return Section("Live") {
            StatGrid(items: recorder.link == .connected ? [
                ("Speed", fmt(s.speed ?? gpsKmh), "km/h"),
                ("RPM", fmt(s.rpm), ""),
                ("Coolant", fmt(s.coolant), "°C"),
                ("Throttle", fmt(s.throttle), "%"),
                ("Load", fmt(s.load), "%"),
                ("Intake air", fmt(s.intakeTemp), "°C"),
                ("MAP", fmt(s.mapKpa), "kPa"),
                ("Battery", fmt(s.voltage, 1), "V"),
                ("Fuel rate", fmt(s.fuelRate, 2), "L/h"),
            ] : [("Speed", fmt(gpsKmh), "km/h")])
        }
    }

    private var rideSection: some View {
        let t = recorder.stats
        return Section("This ride") {
            StatGrid(items: [
                ("Distance", fmt(t.distanceKm, 2), "km"),
                ("Riding", duration(t.movingS), ""),
                ("Idle", duration(t.idleS), ""),
                ("Stops", "\(t.stops)", ""),
                ("Max speed", fmt(t.maxSpeed), "km/h"),
                ("Fuel (est.)", fmt(t.fuelL ?? 0, 2), "L"),
            ])
        }
    }

    private func lastRideSection(_ saved: Recorder.SavedRide) -> some View {
        Section("Last ride saved") {
            Text("\(saved.start.formatted(date: .abbreviated, time: .shortened))–\(saved.end.formatted(date: .omitted, time: .shortened)) · \(fmt(saved.distanceKm, 1)) km")
            Text("Open the History tab to see it on the map and add a note.").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func faultSection(_ dtcs: [String]) -> some View {
        Section("Fault codes") {
            if dtcs.isEmpty {
                Text("No stored codes").foregroundStyle(.green)
            } else {
                ForEach(dtcs, id: \.self) { Text($0).foregroundStyle(.red) }
            }
        }
    }
}

struct AdapterPicker: View {
    @EnvironmentObject private var recorder: Recorder
    @Binding var isPresented: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if !recorder.bluetooth.poweredOn {
                        Text("Turn on Bluetooth and allow Ride Logger to use it.")
                    } else if recorder.bluetooth.discovered.isEmpty {
                        HStack { ProgressView(); Text("Searching… turn the scooter's ignition on.") }
                    }
                    ForEach(recorder.bluetooth.discovered, id: \.identifier) { p in
                        Button(p.name ?? "Unknown") {
                            recorder.choose(p)
                            isPresented = false
                        }
                    }
                } footer: {
                    Text("Close Car Scanner and Bluefy first: the adapter accepts one connection at a time.")
                }
            }
            .navigationTitle("Choose adapter")
            .toolbar { Button("Cancel") { isPresented = false } }
            .onAppear { recorder.bluetooth.startScan() }
            .onDisappear { recorder.bluetooth.stopScan() }
        }
    }
}

struct Pill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }
}

struct StatGrid: View {
    let items: [(String, String, String)]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), alignment: .leading)], alignment: .leading, spacing: 12) {
            ForEach(items, id: \.0) { label, value, unit in
                VStack(alignment: .leading, spacing: 2) {
                    Text(label.uppercased()).font(.caption2).foregroundStyle(.secondary)
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text(value).font(.title2.bold()).monospacedDigit()
                        Text(unit).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

func fmt(_ v: Double?, _ digits: Int = 0) -> String {
    guard let v else { return "–" }
    return String(format: "%.\(digits)f", v)
}

func duration(_ s: Double) -> String {
    let m = Int(s) / 60
    return m >= 60 ? "\(m / 60)h \(m % 60)m" : "\(m)m \(Int(s) % 60)s"
}

private extension View {
    func emailInput() -> some View {
        #if os(iOS)
        return self.keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        return self
        #endif
    }
}
