import CoreBluetooth
import Foundation

enum ElmError: LocalizedError {
    case timeout(String)
    case busy
    case disconnected

    var errorDescription: String? {
        switch self {
        case .timeout(let cmd): return "Timeout: \(cmd)"
        case .busy: return "Adapter busy"
        case .disconnected: return "Adapter disconnected"
        }
    }
}

/// Serial link to an ELM327 over BLE: write a command, collect notifications until the ">" prompt.
@MainActor
final class ElmLink {
    let peripheral: CBPeripheral
    private let writer: CBCharacteristic
    private var buffer = ""
    private var pending: CheckedContinuation<String, Error>?
    private var pendingId = 0

    init(peripheral: CBPeripheral, writer: CBCharacteristic) {
        self.peripheral = peripheral
        self.writer = writer
    }

    func send(_ cmd: String, timeout: TimeInterval = 3) async throws -> String {
        guard pending == nil else { throw ElmError.busy }
        guard peripheral.state == .connected else { throw ElmError.disconnected }
        buffer = ""
        pendingId += 1
        let id = pendingId
        return try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            let type: CBCharacteristicWriteType = writer.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
            let bytes = Array((cmd + "\r").utf8)
            for start in stride(from: 0, to: bytes.count, by: 20) {
                peripheral.writeValue(Data(bytes[start..<min(start + 20, bytes.count)]), for: writer, type: type)
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(timeout))
                if pendingId == id { finish(.failure(ElmError.timeout(cmd))) }
            }
        }
    }

    func received(_ data: Data) {
        buffer += String(decoding: data, as: UTF8.self)
        if let end = buffer.firstIndex(of: ">") {
            let text = String(buffer[..<end])
            buffer = String(buffer[buffer.index(after: end)...])
            finish(.success(text))
        }
    }

    func closed() {
        finish(.failure(ElmError.disconnected))
    }

    private func finish(_ result: Result<String, Error>) {
        guard let continuation = pending else { return }
        pending = nil
        pendingId += 1
        continuation.resume(with: result)
    }
}

/// Finds, connects and reconnects the adapter. The chosen adapter is remembered; iOS keeps a
/// pending connection to it, so it reconnects by itself (even in the background) when the
/// scooter is switched on.
@MainActor
final class BluetoothManager: NSObject, ObservableObject {
    @Published private(set) var poweredOn = false
    @Published private(set) var discovered: [CBPeripheral] = []
    @Published private(set) var savedName: String? = UserDefaults.standard.string(forKey: "adapter-name")

    var onReady: ((ElmLink) -> Void)?
    var onDisconnect: (() -> Void)?

    private var central: CBCentralManager!
    private var target: CBPeripheral?
    private var link: ElmLink?
    private var notifier: CBCharacteristic?
    private var servicesLeft = 0

    private var savedId: UUID? {
        get { UserDefaults.standard.string(forKey: "adapter-id").flatMap(UUID.init) }
        set { UserDefaults.standard.set(newValue?.uuidString, forKey: "adapter-id") }
    }

    var hasSavedAdapter: Bool { savedId != nil }

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionRestoreIdentifierKey: "obd-adapter"])
    }

    func startScan() {
        discovered = []
        guard poweredOn else { return }
        central.scanForPeripherals(withServices: nil)
    }

    func stopScan() {
        if central.isScanning { central.stopScan() }
    }

    func choose(_ peripheral: CBPeripheral) {
        stopScan()
        if let old = target, old.identifier != peripheral.identifier { central.cancelPeripheralConnection(old) }
        savedId = peripheral.identifier
        savedName = peripheral.name
        UserDefaults.standard.set(peripheral.name, forKey: "adapter-name")
        connect(peripheral)
    }

    func forget() {
        savedId = nil
        savedName = nil
        UserDefaults.standard.removeObject(forKey: "adapter-name")
        if let target { central.cancelPeripheralConnection(target) }
        target = nil
    }

    private func connect(_ peripheral: CBPeripheral) {
        target = peripheral
        peripheral.delegate = self
        // No timeout: iOS completes this whenever the adapter powers up.
        central.connect(peripheral)
    }

    private func reconnectSaved() {
        guard poweredOn, let id = savedId else { return }
        if let target, target.state == .connected {
            // Restored by iOS while still connected: rebuild the serial link.
            if link == nil { target.discoverServices(nil) }
            return
        }
        if let p = central.retrievePeripherals(withIdentifiers: [id]).first { connect(p) }
    }

    private func linkClosed() {
        link?.closed()
        link = nil
        notifier = nil
        onDisconnect?()
    }
}

extension BluetoothManager: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated {
            poweredOn = central.state == .poweredOn
            reconnectSaved()
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        MainActor.assumeIsolated {
            if let p = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral])?.first {
                target = p
                p.delegate = self
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        MainActor.assumeIsolated {
            guard peripheral.name != nil, !discovered.contains(where: { $0.identifier == peripheral.identifier }) else { return }
            discovered.append(peripheral)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        MainActor.assumeIsolated {
            peripheral.delegate = self
            peripheral.discoverServices(nil)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated {
            if peripheral.identifier == savedId { connect(peripheral) }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated {
            linkClosed()
            // Scooter switched off: wait for it to come back.
            if peripheral.identifier == savedId { connect(peripheral) }
        }
    }
}

extension BluetoothManager: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        MainActor.assumeIsolated {
            let services = peripheral.services ?? []
            servicesLeft = services.count
            for s in services { peripheral.discoverCharacteristics(nil, for: s) }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        MainActor.assumeIsolated {
            servicesLeft -= 1
            guard link == nil, notifier == nil else { return }
            let chars = service.characteristics ?? []
            // Adapters use different layouts; take the first service that can both notify and write.
            guard let n = chars.first(where: { $0.properties.contains(.notify) || $0.properties.contains(.indicate) }),
                  let w = chars.first(where: { $0.properties.contains(.write) || $0.properties.contains(.writeWithoutResponse) }) else { return }
            notifier = n
            link = ElmLink(peripheral: peripheral, writer: w)
            peripheral.setNotifyValue(true, for: n)
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated {
            if characteristic.isNotifying, characteristic == notifier, let link { onReady?(link) }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated {
            if characteristic == notifier, let data = characteristic.value { link?.received(data) }
        }
    }
}
