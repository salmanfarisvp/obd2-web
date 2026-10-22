// Web Bluetooth transport for BLE ELM327 adapters.
// Adapters use different GATT layouts, so we ask for the common services
// and pick whichever characteristics can notify and write.
const KNOWN_SERVICES: BluetoothServiceUUID[] = [
  0xfff0,
  0xffe0,
  0x18f0,
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2", // Vgate / vLinker
  "0000ae30-0000-1000-8000-00805f9b34fb",
];

export class BleElmTransport {
  private device?: BluetoothDevice;
  private writer?: BluetoothRemoteGATTCharacteristic;
  private buffer = "";
  private pending?: (text: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  onDisconnect?: () => void;

  get name() {
    return this.device?.name ?? "Adapter";
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth isn't available. On iPhone, open this site in the Bluefy browser.");
    }
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: KNOWN_SERVICES,
    });
    this.device.addEventListener("gattserverdisconnected", () => this.onDisconnect?.());
    const server = await this.device.gatt!.connect();

    let notifier: BluetoothRemoteGATTCharacteristic | undefined;
    for (const service of await server.getPrimaryServices()) {
      let chars: BluetoothRemoteGATTCharacteristic[];
      try {
        chars = await service.getCharacteristics();
      } catch {
        continue;
      }
      const n = chars.find((c) => c.properties.notify || c.properties.indicate);
      const w = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write);
      if (n && w) {
        notifier = n;
        this.writer = w;
        break;
      }
    }
    if (!notifier || !this.writer) throw new Error("Couldn't find an ELM327 serial service on this adapter.");

    notifier.addEventListener("characteristicvaluechanged", (e) => {
      const value = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      this.buffer += new TextDecoder().decode(value);
      const end = this.buffer.indexOf(">");
      if (end !== -1 && this.pending) {
        const text = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        const resolve = this.pending;
        this.pending = undefined;
        resolve(text);
      }
    });
    await notifier.startNotifications();
  }

  /** Send one command and resolve with the raw response (prompt stripped). Calls are serialized. */
  send(cmd: string, timeoutMs = 3000): Promise<string> {
    const run = async () => {
      this.buffer = "";
      const response = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = undefined;
          reject(new Error(`Timeout: ${cmd}`));
        }, timeoutMs);
        this.pending = (text) => {
          clearTimeout(timer);
          resolve(text);
        };
      });
      const bytes = new TextEncoder().encode(cmd + "\r");
      for (let i = 0; i < bytes.length; i += 20) {
        const chunk = bytes.slice(i, i + 20);
        if (this.writer!.properties.writeWithoutResponse) await this.writer!.writeValueWithoutResponse(chunk);
        else await this.writer!.writeValueWithResponse(chunk);
      }
      return response;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }
}
