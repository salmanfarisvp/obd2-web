import MapKit
import SwiftUI

// Ride share card, like lib/shareCard.ts on the website: the route coloured by speed over a dimmed
// map, with the ride and engine numbers laid over it.

enum CardFormat: String, CaseIterable, Identifiable {
    case square, story
    var id: String { rawValue }
    var size: CGSize { self == .square ? CGSize(width: 360, height: 360) : CGSize(width: 360, height: 640) }
    /// Where the route sits (points), leaving the lower part for the numbers.
    var routeRegion: CGRect {
        self == .square ? CGRect(x: 30, y: 40, width: 300, height: 133) : CGRect(x: 30, y: 77, width: 300, height: 267)
    }
}

struct CardStat: Identifiable {
    let label: String
    let value: String
    var unit = ""
    var id: String { label }
}

struct ShareCardContent {
    var title: String
    var subtitle: String
    var main: [CardStat]
    var engine: [CardStat]
}

private struct RoutePoint { let point: CGPoint; let color: Color }

private let privacyKm = 0.2

/// Drop the first and last ~200 m so the card doesn't show where you live or park.
private func trimEnds(_ pts: [Reading]) -> [Reading] {
    func cut(_ list: [Reading]) -> [Reading] {
        var km = 0.0
        for i in 1..<max(list.count, 1) {
            km += haversineKm(list[i - 1].lat!, list[i - 1].lon!, list[i].lat!, list[i].lon!)
            if km >= privacyKm { return Array(list[i...]) }
        }
        return []
    }
    return Array(cut(Array(cut(pts).reversed())).reversed())
}

private func speedColor(_ kmh: Double?) -> Color {
    let bands: [(Double, Color)] = [
        (10, Color(red: 0.13, green: 0.77, blue: 0.37)), (25, Color(red: 0.52, green: 0.80, blue: 0.09)),
        (40, Color(red: 0.92, green: 0.70, blue: 0.03)), (55, Color(red: 0.96, green: 0.62, blue: 0.04)),
        (70, Color(red: 0.98, green: 0.45, blue: 0.09)), (.infinity, Color(red: 0.94, green: 0.27, blue: 0.27)),
    ]
    return bands.first { (kmh ?? 0) < $0.0 }!.1
}

/// Render the card as an image (1080 px wide).
@MainActor
func makeShareCard(readings: [Reading], content: ShareCardContent, format: CardFormat, hideEnds: Bool) async -> UIImage? {
    var pts = readings.filter { $0.lat != nil && $0.lon != nil }
    if hideEnds { pts = trimEnds(pts) }

    var mapImage: UIImage?
    var route: [RoutePoint] = []
    if pts.count > 1 {
        // Pick the visible map area so the route's bounding box lands in the route region.
        let mapPoints = pts.map { MKMapPoint(CLLocationCoordinate2D(latitude: $0.lat!, longitude: $0.lon!)) }
        let xs = mapPoints.map(\.x), ys = mapPoints.map(\.y)
        let box = MKMapRect(x: xs.min()!, y: ys.min()!, width: max(xs.max()! - xs.min()!, 1), height: max(ys.max()! - ys.min()!, 1))
        let region = format.routeRegion
        let size = format.size
        // At least ~1 km across the route region, so short rides aren't drawn at building scale.
        let minUnits = 1000 * MKMapPointsPerMeterAtLatitude(pts[0].lat!) / region.width
        let unitsPerPoint = max(box.width / region.width, box.height / region.height, minUnits)
        let visible = MKMapRect(
            x: box.midX - region.midX * unitsPerPoint,
            y: box.midY - region.midY * unitsPerPoint,
            width: size.width * unitsPerPoint,
            height: size.height * unitsPerPoint
        )
        let options = MKMapSnapshotter.Options()
        options.mapRect = visible
        options.size = size
        options.scale = 3
        options.traitCollection = UITraitCollection(userInterfaceStyle: .dark)
        options.preferredConfiguration = MKStandardMapConfiguration(emphasisStyle: .muted)
        options.pointOfInterestFilter = .excludingAll
        if let snapshot = try? await MKMapSnapshotter(options: options).start() {
            mapImage = snapshot.image
            route = pts.map { RoutePoint(point: snapshot.point(for: CLLocationCoordinate2D(latitude: $0.lat!, longitude: $0.lon!)),
                                         color: speedColor($0.displaySpeed)) }
        }
    }

    let card = CardView(content: content, format: format, mapImage: mapImage, route: route)
        .frame(width: format.size.width, height: format.size.height)
    let renderer = ImageRenderer(content: card)
    renderer.scale = 3
    return renderer.uiImage
}

private struct CardView: View {
    let content: ShareCardContent
    let format: CardFormat
    let mapImage: UIImage?
    let route: [RoutePoint]

    private var story: Bool { format == .story }

    var body: some View {
        ZStack(alignment: .topLeading) {
            LinearGradient(colors: [Color(red: 0.12, green: 0.23, blue: 0.54), Color(red: 0.04, green: 0.06, blue: 0.13)],
                           startPoint: .top, endPoint: .bottom)
            if let mapImage {
                Image(uiImage: mapImage).resizable().saturation(0.2)
                Color.black.opacity(0.45) // a little dim, so the route and text stand out
            }
            routeLayer
            // Darken the bottom for the numbers.
            LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black.opacity(0.85), location: 0.35),
                                   .init(color: .black.opacity(0.95), location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: format.size.height - (story ? 307 : 147))
                .frame(maxHeight: .infinity, alignment: .bottom)
            text
        }
        .environment(\.colorScheme, .dark)
    }

    private var routeLayer: some View {
        Canvas { ctx, _ in
            guard route.count > 1 else { return }
            var path = Path()
            path.addLines(route.map(\.point))
            ctx.stroke(path, with: .color(.black.opacity(0.75)), style: StrokeStyle(lineWidth: 5.5, lineCap: .round, lineJoin: .round))
            for i in 1..<route.count {
                var seg = Path()
                seg.move(to: route[i - 1].point)
                seg.addLine(to: route[i].point)
                ctx.stroke(seg, with: .color(route[i].color), style: StrokeStyle(lineWidth: 3, lineCap: .round))
            }
            for (p, color) in [(route.first!.point, Color.green), (route.last!.point, Color.red)] {
                let dot = Path(ellipseIn: CGRect(x: p.x - 4.5, y: p.y - 4.5, width: 9, height: 9))
                ctx.fill(dot, with: .color(color))
                ctx.stroke(dot, with: .color(.white), lineWidth: 1.7)
            }
        }
    }

    private var text: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("🛵  RIDE LOGGER").font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.85))
            Spacer()
            Text(content.title).font(.system(size: story ? 21 : 18, weight: .heavy)).lineLimit(1).minimumScaleFactor(0.6)
            Text(content.subtitle).font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                .padding(.bottom, story ? 22 : 14)
            statGrid(content.main, columns: story ? 2 : 4, value: story ? 32 : 22, label: 8, rowGap: story ? 14 : 8)
            Rectangle().fill(.white.opacity(0.18)).frame(height: 0.7).padding(.vertical, story ? 14 : 10)
            statGrid(Array(content.engine.prefix(story ? 6 : 5)), columns: story ? 3 : 5, value: story ? 18 : 13, label: 6.7, rowGap: 10)
        }
        .foregroundStyle(.white)
        .shadow(color: .black.opacity(0.7), radius: 2.5)
        .padding(.horizontal, 23)
        .padding(.top, 20)
        .padding(.bottom, story ? 30 : 22)
    }

    private func statGrid(_ stats: [CardStat], columns: Int, value: CGFloat, label: CGFloat, rowGap: CGFloat) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6, alignment: .leading), count: columns),
                  alignment: .leading, spacing: rowGap) {
            ForEach(stats) { s in
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.label.uppercased()).font(.system(size: label, weight: .bold)).foregroundStyle(.white.opacity(0.6))
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(s.value).font(.system(size: value, weight: .heavy)).monospacedDigit()
                        if !s.unit.isEmpty {
                            Text(s.unit).font(.system(size: value * 0.4, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
                        }
                    }
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
                }
            }
        }
    }
}

/// "Morning ride" etc., Strava-style, from the start time.
func rideTitle(_ start: Date, note: String?) -> String {
    if let note, !note.isEmpty { return note }
    let h = Calendar.current.component(.hour, from: start)
    return h < 5 ? "Night ride" : h < 12 ? "Morning ride" : h < 17 ? "Afternoon ride" : h < 21 ? "Evening ride" : "Night ride"
}

struct ShareRideSheet: View {
    let readings: [Reading]
    let content: ShareCardContent
    @Environment(\.dismiss) private var dismiss
    @State private var format: CardFormat = .square
    @State private var hideEnds = true
    @State private var image: UIImage?

    var body: some View {
        NavigationStack {
            Form {
                Picker("Size", selection: $format) {
                    Text("Square").tag(CardFormat.square)
                    Text("Story").tag(CardFormat.story)
                }
                .pickerStyle(.segmented)
                Toggle("Hide where the ride starts and ends", isOn: $hideEnds)
                Section {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12))
                            .frame(maxHeight: 460)
                    } else {
                        HStack { ProgressView(); Text("Creating card…") }
                    }
                }
            }
            .navigationTitle("Share ride")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    if let image {
                        let picture = Image(uiImage: image)
                        ShareLink(item: picture, preview: SharePreview(content.title, image: picture)) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                    }
                }
            }
            .task(id: "\(format.rawValue)-\(hideEnds)") {
                image = nil
                image = await makeShareCard(readings: readings, content: content, format: format, hideEnds: hideEnds)
            }
        }
    }
}
