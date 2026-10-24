import Charts
import MapKit
import SwiftUI

// MARK: - Ride list

struct RidesView: View {
    @EnvironmentObject private var fuel: FuelStore
    @ObservedObject private var store = LocalStore.shared
    @State private var uploaded: [RideRecord]?
    @State private var error: String?
    @State private var selecting = false
    @State private var selected: Set<String> = []
    @State private var confirmMerge = false
    @State private var merging = false
    @State private var actionError: String?

    /// Two or more uploaded rides on the same vehicle.
    private var canMerge: Bool {
        let picked = (uploaded ?? []).filter { selected.contains($0.id) }
        return picked.count >= 2 && Set(picked.map(\.vehicleName)).count == 1
    }

    /// Rides still on the phone first, then those in Supabase.
    private var rides: [RideRecord]? {
        guard let uploaded else { return nil }
        let local = store.pending
        return local + uploaded.filter { r in !local.contains { $0.id == r.id } }
    }

    var body: some View {
        NavigationStack {
            List {
                if let rides {
                    totals(rides)
                    Section("Mileage & cost") {
                        ForEach(Array(Set(rides.map(\.vehicleName))).sorted(), id: \.self) { VehicleCostCard(vehicle: $0) }
                    }
                    Section {
                        if rides.isEmpty { Text("No rides yet.").foregroundStyle(.secondary) }
                        ForEach(rides) { ride in
                            let row = RideRow(ride: ride, cost: fuel.cost(for: ride).map { money(fuel.currency, $0) })
                            if selecting {
                                Button {
                                    if selected.contains(ride.id) { selected.remove(ride.id) } else { selected.insert(ride.id) }
                                } label: {
                                    HStack {
                                        Image(systemName: selected.contains(ride.id) ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(selected.contains(ride.id) ? Color.accentColor : .secondary)
                                        row
                                    }
                                }
                                .buttonStyle(.plain)
                                .disabled(ride.pending) // only uploaded rides can be merged
                            } else {
                                NavigationLink(value: ride.id) { row }
                            }
                        }
                    } header: {
                        Text("Rides")
                    } footer: {
                        if selecting {
                            Text("Pick two or more rides on the same vehicle; the time between them becomes breaks.")
                        }
                    }
                } else if let error {
                    Text(error).foregroundStyle(.red)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("History")
            .toolbar {
                if selecting {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Cancel") { selecting = false; selected = [] }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(merging ? "Merging…" : "Merge \(selected.count)") { confirmMerge = true }
                            .disabled(!canMerge || merging)
                    }
                } else if (rides?.count ?? 0) > 1 {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Select") { selecting = true }
                    }
                }
            }
            .alert("Couldn't merge", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
                Button("OK") {}
            } message: {
                Text(actionError ?? "")
            }
            .confirmationDialog("Merge \(selected.count) rides into one?", isPresented: $confirmMerge, titleVisibility: .visible) {
                Button("Merge") { merge() }
            } message: {
                Text("The time between them becomes breaks. This can't be undone.")
            }
            .navigationDestination(for: String.self) { id in
                if let ride = rides?.first(where: { $0.id == id }) {
                    RideDetailView(ride: ride, onChange: { updated in
                        if let i = uploaded?.firstIndex(where: { $0.id == updated.id }) { uploaded?[i] = updated }
                    }, onDelete: {
                        uploaded?.removeAll { $0.id == id }
                    })
                }
            }
            .refreshable {
                await store.uploadFinished()
                await load()
            }
            .task { if uploaded == nil { await load() } }
            // A ride just finished uploading: show the server copy.
            .onChange(of: store.pending.count) { _, _ in Task { await load() } }
        }
    }

    private func merge() {
        let picked = (uploaded ?? []).filter { selected.contains($0.id) }
        merging = true
        Task {
            do {
                let merged = try await History.merge(picked)
                uploaded = uploaded?.filter { !selected.contains($0.id) || $0.id == merged.id }.map { $0.id == merged.id ? merged : $0 }
                selected = []
                selecting = false
            } catch {
                actionError = error.localizedDescription
            }
            merging = false
        }
    }

    private func load() async {
        async let fuelData: Void = fuel.load()
        do {
            uploaded = try await History.rides()
            await fuelData
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func totals(_ rides: [RideRecord]) -> some View {
        Section {
            StatGrid(items: [
                ("Rides", "\(rides.count)", ""),
                ("Distance", fmt(rides.reduce(0) { $0 + ($1.distanceKm ?? 0) }, 1), "km"),
                ("Total time", duration(rides.reduce(0) { $0 + ($1.durationS ?? 0) }), ""),
                ("Riding", duration(rides.reduce(0) { $0 + ($1.movingS ?? 0) }), ""),
                ("Idle", duration(rides.reduce(0) { $0 + ($1.idleS ?? 0) }), ""),
            ])
        }
    }
}

private struct RideRow: View {
    let ride: RideRecord
    let cost: String?

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(timeRange(ride)).font(.subheadline.weight(.semibold))
                Text("\(ride.vehicleName) · \(duration(ride.durationS ?? 0))\((ride.breaks ?? 0) > 0 ? " · ☕ \(ride.breaks!)" : "")\(ride.recording ? " · ● recording" : ride.pending ? " · ⏳ not uploaded yet" : ride.endedAt == nil ? " · in progress" : "")")
                    .font(.caption).foregroundStyle(.secondary)
                if let note = ride.note, !note.isEmpty {
                    Text("📝 \(note)").font(.caption).lineLimit(2)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(fmt(ride.distanceKm ?? 0, 1)) km").font(.subheadline.bold())
                Text(cost ?? "max \(fmt(ride.maxSpeed ?? 0)) km/h").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private func timeRange(_ ride: RideRecord) -> String {
    let start = ride.startedAt.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
    guard let end = ride.endedAt else { return start }
    return "\(start)–\(end.formatted(date: .omitted, time: .shortened))"
}

// MARK: - Ride detail

private struct ChartPoint: Identifiable {
    let id: Int // index into readings
    let minute: Double
    let reading: Reading
}

private struct Segment: Identifiable {
    let id: Int
    let coords: [CLLocationCoordinate2D]
    let color: Color
}

// Slow → fast, green → red. Same bands as the website.
private let speedBands: [(max: Double, color: Color, label: String)] = [
    (10, Color(red: 0.13, green: 0.77, blue: 0.37), "<10"),
    (25, Color(red: 0.52, green: 0.80, blue: 0.09), "10–25"),
    (40, Color(red: 0.92, green: 0.70, blue: 0.03), "25–40"),
    (55, Color(red: 0.96, green: 0.62, blue: 0.04), "40–55"),
    (70, Color(red: 0.98, green: 0.45, blue: 0.09), "55–70"),
    (.infinity, Color(red: 0.94, green: 0.27, blue: 0.27), "70+"),
]
private func band(_ speed: Double?) -> Int { speedBands.firstIndex { (speed ?? 0) < $0.max } ?? 0 }

struct RideDetailView: View {
    @State var ride: RideRecord
    let onChange: (RideRecord) -> Void
    let onDelete: () -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var fuel: FuelStore
    @State private var readings: [Reading] = []
    @State private var codes: [String] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var cursor = 0
    @State private var playing = false
    @State private var rate = 30
    @State private var note = ""
    @State private var noteStatus: String?
    @State private var confirmDelete = false
    @State private var sharing = false

    // Derived once readings load.
    @State private var segments: [Segment] = []
    @State private var positions: [CLLocationCoordinate2D?] = []
    @State private var gpsIndices: [Int] = []
    @State private var chartPoints: [ChartPoint] = []
    @State private var selectedMinute: Double?
    @State private var breakPins: [(coordinate: CLLocationCoordinate2D, seconds: Double)] = []

    private static let maxChartPoints = 300

    var body: some View {
        List {
            summarySection
            noteSection
            if segments.isEmpty == false { mapSection }
            if readings.count > 1 { replaySection }
            if chartPoints.count > 1 { chartsSection }
            Section("Fault codes") {
                if codes.isEmpty {
                    Text("None recorded").foregroundStyle(.green)
                } else {
                    ForEach(codes, id: \.self) { Text($0).foregroundStyle(.red) }
                }
            }
            Section {
                Button("Delete ride", role: .destructive) { confirmDelete = true }.disabled(ride.recording)
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle(ride.startedAt.formatted(date: .abbreviated, time: .shortened))
        .keyboardDismissable()
        .toolbar {
            if !readings.isEmpty {
                Button { sharing = true } label: { Image(systemName: "square.and.arrow.up") }
            }
        }
        .sheet(isPresented: $sharing) { ShareRideSheet(readings: readings, content: shareContent) }
        .confirmationDialog("Delete this ride?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { delete() }
        }
        .task { if !loaded { await load() } }
        .task(id: playing) { await play() }
        .onChange(of: selectedMinute) { _, minute in
            guard let minute, let nearest = chartPoints.min(by: { abs($0.minute - minute) < abs($1.minute - minute) }) else { return }
            playing = false
            cursor = nearest.id
        }
    }

    private var shareContent: ShareCardContent {
        let km = ride.distanceKm ?? 0
        let ridingS = (ride.movingS ?? 0) > 0 ? ride.movingS! : (ride.durationS ?? 0)
        let litres = fuel.fuel(for: ride)
        let cost = fuel.cost(for: ride)
        let coolant = readings.compactMap(\.sample.coolant).max()
        var engine: [CardStat] = []
        if let rpm = ride.maxRpm { engine.append(CardStat(label: "Max RPM", value: fmt(rpm))) }
        if let coolant { engine.append(CardStat(label: "Coolant", value: fmt(coolant), unit: "°C")) }
        if let litres, litres > 0 {
            engine.append(CardStat(label: "Fuel", value: fmt(litres, 2), unit: "L"))
            if km > 0 { engine.append(CardStat(label: "Mileage", value: fmt(km / litres, 1), unit: "km/L")) }
        }
        if let cost { engine.append(CardStat(label: "Cost", value: money(fuel.currency, cost))) }
        if let idle = ride.idleS, idle > 0 { engine.append(CardStat(label: "Idle", value: duration(idle))) }
        let date = ride.startedAt.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
        return ShareCardContent(
            title: rideTitle(ride.startedAt, note: ride.note),
            subtitle: "\(date) · \(ride.vehicleName)",
            main: [
                CardStat(label: "Distance", value: fmt(km, km < 10 ? 2 : 1), unit: "km"),
                CardStat(label: "Riding time", value: duration(ridingS)),
                CardStat(label: "Avg speed", value: ridingS > 0 ? fmt(km / (ridingS / 3600)) : "–", unit: "km/h"),
                CardStat(label: "Top speed", value: fmt(ride.maxSpeed ?? 0), unit: "km/h"),
            ],
            engine: engine
        )
    }

    // MARK: Sections

    private var summarySection: some View {
        let litres = fuel.fuel(for: ride)
        let cost = fuel.cost(for: ride)
        let km = ride.distanceKm ?? 0
        let calibrated = fuel.mileage(for: ride.vehicleName)?.calibration != nil
        return Section {
            Text("\(ride.vehicleName) · \(timeRange(ride))").font(.caption).foregroundStyle(.secondary)
            StatGrid(items: [
                ("Distance", fmt(ride.distanceKm ?? 0, 2), "km"),
                ("Duration", duration(ride.durationS ?? 0), ""),
                ("Riding", ride.movingS.map(duration) ?? "–", ""),
                ("Idle", ride.idleS.map(duration) ?? "–", ""),
                ("Stops", ride.stops.map(String.init) ?? "–", ""),
                ("Breaks", (ride.breaks ?? 0) > 0 ? "\(ride.breaks!) · \(duration(ride.breakS ?? 0))" : "–", ""),
                ("Avg speed", fmt(ride.avgSpeed ?? 0), "km/h"),
                ("Max speed", fmt(ride.maxSpeed ?? 0), "km/h"),
                ("Max RPM", fmt(ride.maxRpm), ""),
                ("Max coolant", fmt(ride.maxCoolant), "°C"),
                (ride.fuelL == nil ? "Fuel (from mileage)" : calibrated ? "Fuel (calibrated)" : "Fuel (est.)", fmt(litres, 2), "L"),
                ("Mileage", litres.flatMap { $0 > 0 && km > 0 ? fmt(km / $0, 1) : nil } ?? "–", "km/L"),
                ("Cost", cost.map { money(fuel.currency, $0) } ?? "–", ""),
                ("Cost / km", cost.flatMap { km > 0 ? money(fuel.currency, $0 / km) : nil } ?? "–", ""),
            ])
            if litres != nil, fuel.price(at: ride.startedAt) == nil {
                Text("Set your petrol price in the Profile tab to see this ride's cost.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var noteSection: some View {
        Section("Note") {
            TextField("Add a note, e.g. office commute", text: $note, axis: .vertical)
                .onChange(of: note) { _, _ in noteStatus = nil }
            HStack {
                Button("Save note") { saveNote() }.disabled(note == (ride.note ?? ""))
                if let noteStatus { Text(noteStatus).font(.caption).foregroundStyle(.secondary) }
            }
        }
    }

    private var mapSection: some View {
        Section {
            MapReader { proxy in
                Map(initialPosition: .rect(boundingRect)) {
                    ForEach(segments) { s in
                        MapPolyline(coordinates: s.coords).stroke(s.color, lineWidth: 5)
                    }
                    if let start = segments.first?.coords.first {
                        Annotation("Start", coordinate: start) { dot(.green, size: 12) }
                    }
                    if let end = segments.last?.coords.last {
                        Annotation("End", coordinate: end) { dot(.red, size: 12) }
                    }
                    ForEach(Array(breakPins.enumerated()), id: \.offset) { _, b in
                        Annotation("\(Int(b.seconds / 60)) min", coordinate: b.coordinate) { Text("☕").font(.title3) }
                    }
                    if cursor < positions.count, let here = positions[cursor] {
                        Annotation("", coordinate: here) { dot(.blue, size: 18) }
                    }
                }
                .onTapGesture { point in
                    if let coordinate = proxy.convert(point, from: .local) { jump(to: coordinate) }
                }
            }
            .frame(height: 320)
            .listRowInsets(EdgeInsets())
            HStack(spacing: 8) {
                Text("km/h").font(.caption2).foregroundStyle(.secondary)
                ForEach(speedBands, id: \.label) { b in
                    HStack(spacing: 3) {
                        Capsule().fill(b.color).frame(width: 12, height: 4)
                        Text(b.label).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            Text("Replay")
        } footer: {
            Text("Tap the route to jump to that moment.")
        }
    }

    private var replaySection: some View {
        let r = readings[cursor]
        let elapsed = r.ts.timeIntervalSince(readings[0].ts)
        return Section {
            HStack {
                Text(r.ts.formatted(date: .omitted, time: .standard)).bold()
                Text("· \(Int(elapsed) / 60):\(String(format: "%02d", Int(elapsed) % 60)) in").foregroundStyle(.secondary)
                if r.lat == nil { Pill(text: "no GPS", color: .orange) }
                Spacer()
                Picker("Speed", selection: $rate) {
                    ForEach([10, 30, 60], id: \.self) { Text("\($0)×").tag($0) }
                }
                .labelsHidden()
                Button {
                    if !playing, cursor >= readings.count - 1 { cursor = 0 }
                    playing.toggle()
                } label: {
                    Image(systemName: playing ? "pause.fill" : "play.fill")
                }
                .buttonStyle(.borderless)
            }
            Slider(
                value: Binding(get: { Double(cursor) }, set: { playing = false; cursor = Int($0) }),
                in: 0...Double(readings.count - 1),
                step: 1
            )
            StatGrid(items: [
                ("Speed", fmt(r.displaySpeed), "km/h"),
                ("RPM", fmt(r.sample.rpm), ""),
                ("Throttle", fmt(r.sample.throttle), "%"),
                ("Load", fmt(r.sample.load), "%"),
                ("Coolant", fmt(r.sample.coolant), "°C"),
                ("Intake air", fmt(r.sample.intakeTemp), "°C"),
                ("Battery", fmt(r.sample.voltage, 1), "V"),
                ("Fuel rate", fmt(r.sample.fuelRate, 2), "L/h"),
            ])
        }
    }

    private var chartsSection: some View {
        let cursorMinute = readings[cursor].ts.timeIntervalSince(readings[0].ts) / 60
        return Group {
            chart("Speed (km/h)", [("Speed", .blue, { $0.displaySpeed })], cursorMinute)
            chart("RPM", [("RPM", .orange, { $0.sample.rpm })], cursorMinute)
            chart("Temperatures (°C)", [("Coolant", .red, { $0.sample.coolant }), ("Intake air", .green, { $0.sample.intakeTemp })], cursorMinute)
            chart("Throttle & load (%)", [("Throttle", .purple, { $0.sample.throttle }), ("Load", .teal, { $0.sample.load })], cursorMinute)
            chart("Battery (V)", [("Volts", .yellow, { $0.sample.voltage })], cursorMinute)
        }
    }

    private func chart(_ title: String, _ series: [(name: String, color: Color, value: (Reading) -> Double?)], _ cursorMinute: Double) -> some View {
        let hasData = series.contains { s in chartPoints.contains { s.value($0.reading) != nil } }
        return Group {
            if hasData {
                Section(title) {
                    Chart {
                        ForEach(series, id: \.name) { s in
                            ForEach(chartPoints) { p in
                                if let v = s.value(p.reading) {
                                    LineMark(x: .value("Minute", p.minute), y: .value(s.name, v), series: .value("Series", s.name))
                                        .foregroundStyle(s.color)
                                        .interpolationMethod(.monotone)
                                }
                            }
                        }
                        RuleMark(x: .value("Now", cursorMinute))
                            .foregroundStyle(.white.opacity(0.6))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    }
                    .chartXAxis { AxisMarks { v in AxisGridLine(); AxisValueLabel { Text("\(v.as(Double.self).map { Int($0) } ?? 0)m") } } }
                    .chartXSelection(value: $selectedMinute)
                    .frame(height: 160)
                    if series.count > 1 {
                        HStack(spacing: 12) {
                            ForEach(series, id: \.name) { s in
                                HStack(spacing: 4) {
                                    Capsule().fill(s.color).frame(width: 12, height: 4)
                                    Text(s.name).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func dot(_ color: Color, size: CGFloat) -> some View {
        Circle().fill(color).frame(width: size, height: size).overlay(Circle().stroke(.white, lineWidth: 2.5))
    }

    // MARK: Data

    private var boundingRect: MKMapRect {
        let points = segments.flatMap(\.coords).map(MKMapPoint.init)
        var rect = points.reduce(MKMapRect.null) { $0.union(MKMapRect(origin: $1, size: MKMapSize(width: 0, height: 0))) }
        let pad = max(rect.size.width, rect.size.height) * 0.15 + 300
        rect = rect.insetBy(dx: -pad, dy: -pad)
        return rect
    }

    private func load() async {
        if ride.pending {
            // Still on the phone: read it from there.
            readings = LocalStore.shared.readings(ride.id)
            codes = LocalStore.shared.faultCodes(ride.id)
            ride.fillMissing(from: readings)
            note = ride.note ?? ""
            prepare()
            loaded = true
            return
        }
        do {
            async let rows = History.readings(rideId: ride.id)
            async let faults = History.faultCodes(rideId: ride.id)
            readings = try await rows
            codes = (try? await faults) ?? []
            ride.fillMissing(from: readings)
            note = ride.note ?? ""
            prepare()
            loaded = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func prepare() {
        // Route split into runs of the same speed band, sharing the boundary point so there are no gaps.
        var segs: [Segment] = []
        var current: (band: Int, coords: [CLLocationCoordinate2D])?
        var last: CLLocationCoordinate2D?
        var pos: [CLLocationCoordinate2D?] = []
        var gps: [Int] = []
        for (i, r) in readings.enumerated() {
            if let lat = r.lat, let lon = r.lon {
                let c = CLLocationCoordinate2D(latitude: lat, longitude: lon)
                last = c
                gps.append(i)
                let b = band(r.displaySpeed)
                if let cur = current, cur.band == b {
                    current?.coords.append(c)
                } else {
                    if let cur = current { segs.append(Segment(id: segs.count, coords: cur.coords + [c], color: speedBands[cur.band].color)) }
                    current = (b, [c])
                }
            }
            pos.append(last) // last known position for readings without GPS
        }
        if let cur = current { segs.append(Segment(id: segs.count, coords: cur.coords, color: speedBands[cur.band].color)) }
        segments = segs.count == 1 && segs[0].coords.count < 2 ? [] : segs
        positions = pos
        gpsIndices = gps
        breakPins = findBreaks(readings).compactMap { b in
            guard let lat = b.lat, let lon = b.lon else { return nil }
            return (CLLocationCoordinate2D(latitude: lat, longitude: lon), b.seconds)
        }

        let step = max(1, readings.count / Self.maxChartPoints)
        let t0 = readings.first?.ts ?? Date()
        chartPoints = stride(from: 0, to: readings.count, by: step).map {
            ChartPoint(id: $0, minute: readings[$0].ts.timeIntervalSince(t0) / 60, reading: readings[$0])
        }
    }

    private func jump(to coordinate: CLLocationCoordinate2D) {
        let cos = Foundation.cos(coordinate.latitude * .pi / 180)
        let nearest = gpsIndices.min { a, b in
            dist(readings[a], coordinate, cos) < dist(readings[b], coordinate, cos)
        }
        if let nearest {
            playing = false
            cursor = nearest
        }
    }

    private func dist(_ r: Reading, _ c: CLLocationCoordinate2D, _ cos: Double) -> Double {
        let dLat = (r.lat ?? 0) - c.latitude
        let dLon = ((r.lon ?? 0) - c.longitude) * cos
        return dLat * dLat + dLon * dLon
    }

    private func play() async {
        guard playing else { return }
        let tick = 0.1
        while playing, !Task.isCancelled, cursor < readings.count - 1 {
            try? await Task.sleep(for: .milliseconds(Int(tick * 1000)))
            let target = readings[cursor].ts.addingTimeInterval(tick * Double(rate))
            var i = cursor
            while i < readings.count - 1, readings[i + 1].ts <= target { i += 1 }
            cursor = max(i, min(cursor + 1, readings.count - 1))
        }
        playing = false
    }

    private func saveNote() {
        noteStatus = "Saving…"
        Task {
            do {
                let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                if LocalStore.shared.isPending(ride.id) {
                    LocalStore.shared.setNote(id: ride.id, note: trimmed.isEmpty ? nil : trimmed) // uploaded with the ride
                } else {
                    try await History.saveNote(rideId: ride.id, note: note)
                }
                ride.note = note.trimmingCharacters(in: .whitespacesAndNewlines)
                note = ride.note ?? ""
                onChange(ride)
                noteStatus = "Saved"
            } catch {
                noteStatus = "Couldn't save: \(error.localizedDescription)"
            }
        }
    }

    private func delete() {
        Task {
            do {
                if LocalStore.shared.isPending(ride.id) {
                    LocalStore.shared.discard(id: ride.id)
                } else {
                    try await History.delete(rideId: ride.id)
                }
                onDelete()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
