import Foundation

/// On-device diagnostics: what the app, GPS, Bluetooth and uploads did, with timestamps.
/// Shown under Profile → Diagnostics so a bad ride can be explained instead of guessed at.
enum DiagLog {
    private static let file: URL = LocalStore.directory.appendingPathComponent("diagnostics.log")
    private static let maxBytes = 400_000
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm:ss"
        return f
    }()

    static func log(_ message: String) {
        let line = "\(formatter.string(from: Date())) \(message)\n"
        let data = Data(line.utf8)
        if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            if let size = try? handle.offset(), size > UInt64(maxBytes) { trim() }
        } else {
            LocalStore.create(file, contents: data)
        }
    }

    static func read() -> String {
        (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    }

    static func clear() {
        try? FileManager.default.removeItem(at: file)
    }

    /// Keep the newest half when the log gets big.
    private static func trim() {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return }
        let keep = text.suffix(maxBytes / 2)
        let fromLine = keep.firstIndex(of: "\n").map { keep.index(after: $0) } ?? keep.startIndex
        LocalStore.create(file, contents: Data(keep[fromLine...].utf8))
    }
}
