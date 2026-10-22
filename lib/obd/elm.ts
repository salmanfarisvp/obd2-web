import { BleElmTransport } from "./ble";
import { FAST_KEYS, PIDS, PidKey, estimateFuelRate, parseDtcs, parseMode01 } from "./pids";

export type Sample = Partial<Record<PidKey, number>> & { voltage?: number; fuel_rate?: number };

export class Elm327 {
  readonly transport = new BleElmTransport();
  private slowIndex = 0;
  private latest: Sample = {};

  async connect() {
    await this.transport.connect();
    await this.init();
  }

  async reconnect() {
    await this.transport.reconnect();
    await this.init();
  }

  /** Set up the adapter for the scooter's CAN bus. The ECU may still be off; poll() reports that. */
  private async init() {
    this.latest = {};
    for (const cmd of ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATAT1", "ATSP6"]) {
      await this.transport.send(cmd, cmd === "ATZ" ? 5000 : 2000);
    }
  }

  private async readPid(key: PidKey): Promise<boolean> {
    const def = PIDS.find((p) => p.key === key)!;
    try {
      const bytes = parseMode01(await this.transport.send("01" + def.pid), def.pid);
      if (bytes && bytes.length) {
        this.latest[key] = def.decode(bytes);
        return true;
      }
    } catch {
      // A missed reading is fine; keep the previous value.
    }
    return false;
  }

  /**
   * One polling cycle: fast PIDs plus one rotating slow PID.
   * `ecuOk` is false when the ECU didn't answer for RPM this cycle (ignition off).
   */
  async poll(): Promise<{ sample: Sample; ecuOk: boolean }> {
    const ecuOk = await this.readPid("rpm");
    if (!ecuOk) return { sample: { ...this.latest }, ecuOk };

    for (const key of FAST_KEYS) if (key !== "rpm") await this.readPid(key);
    const slow = PIDS.filter((p) => !FAST_KEYS.includes(p.key));
    const next = this.slowIndex++ % (slow.length + 1);
    if (next === slow.length) {
      try {
        const v = parseFloat((await this.transport.send("ATRV")).replace(/[^\d.]/g, ""));
        if (!Number.isNaN(v)) this.latest.voltage = v;
      } catch {}
    } else {
      await this.readPid(slow[next].key);
    }
    const { rpm, map_kpa, intake_temp } = this.latest;
    if (rpm !== undefined && map_kpa !== undefined) {
      this.latest.fuel_rate = rpm > 0 ? estimateFuelRate(rpm, map_kpa, intake_temp ?? 30) : 0;
    }
    return { sample: { ...this.latest }, ecuOk };
  }

  async readDtcs(): Promise<string[]> {
    return parseDtcs(await this.transport.send("03", 5000));
  }

  disconnect() {
    this.transport.disconnect();
  }
}
