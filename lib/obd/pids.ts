// Mode 01 PIDs reported by the Suzuki Access 125 ECU (CAN 11-bit, 500k, ECU 7E8).
export type PidKey =
  | "rpm" | "speed" | "throttle" | "map_kpa" | "load"
  | "coolant" | "intake_temp" | "timing" | "stft" | "ltft" | "fuel_level";

export type PidDef = { pid: string; key: PidKey; decode: (b: number[]) => number };

export const PIDS: PidDef[] = [
  { pid: "0C", key: "rpm", decode: ([a, b]) => (a * 256 + b) / 4 },
  { pid: "0D", key: "speed", decode: ([a]) => a },
  { pid: "11", key: "throttle", decode: ([a]) => (a * 100) / 255 },
  { pid: "0B", key: "map_kpa", decode: ([a]) => a },
  { pid: "04", key: "load", decode: ([a]) => (a * 100) / 255 },
  { pid: "05", key: "coolant", decode: ([a]) => a - 40 },
  { pid: "0F", key: "intake_temp", decode: ([a]) => a - 40 },
  { pid: "0E", key: "timing", decode: ([a]) => a / 2 - 64 },
  { pid: "06", key: "stft", decode: ([a]) => (a * 100) / 128 - 100 },
  { pid: "07", key: "ltft", decode: ([a]) => (a * 100) / 128 - 100 },
  // Not in Car Scanner's list for the Access 125, so probably unsupported; harmless to ask.
  { pid: "2F", key: "fuel_level", decode: ([a]) => (a * 100) / 255 },
];

// Polled every cycle; the rest rotate one per cycle.
export const FAST_KEYS: PidKey[] = ["rpm", "speed", "throttle", "map_kpa"];

/** Pull data bytes for "41 <pid>" out of an ELM response (spaces/headers off). */
export function parseMode01(raw: string, pid: string): number[] | null {
  const hex = raw.replace(/\s/g, "").toUpperCase();
  const at = hex.indexOf("41" + pid);
  if (at === -1) return null;
  const data = hex.slice(at + 4).match(/.{2}/g) ?? [];
  return data.map((h) => parseInt(h, 16)).filter((n) => !Number.isNaN(n));
}

/** Decode mode 03 (stored DTCs). Handles CAN single and multi-frame responses. */
export function parseDtcs(raw: string): string[] {
  const lines = raw
    .split(/[\r\n]+/)
    .map((l) => l.trim().replace(/^[0-9A-F]:/i, "").replace(/\s/g, ""))
    .filter((l) => /^[0-9A-F]+$/i.test(l) && l.length > 3); // drop the multi-frame length line
  const hex = lines.join("").toUpperCase();
  const at = hex.indexOf("43");
  if (at === -1) return [];
  // CAN: 43 <count> then 2-byte codes
  const body = hex.slice(at + 4);
  const codes: string[] = [];
  for (let i = 0; i + 4 <= body.length; i += 4) {
    const word = body.slice(i, i + 4);
    if (word === "0000") continue;
    const first = parseInt(word[0], 16);
    codes.push("PCBU"[first >> 2] + (first & 3).toString() + word.slice(1));
  }
  return codes;
}

/**
 * Estimated fuel flow (L/h) using speed-density, since the ECU has no MAF sensor.
 * Defaults are for the Access 125: 124 cc single cylinder, ~85% volumetric efficiency.
 */
export function estimateFuelRate(rpm: number, mapKpa: number, iatC: number, displacementCc = 124, ve = 0.85) {
  const airDensity = (mapKpa * 1000) / (287.05 * (iatC + 273.15)); // kg/m³
  const airPerIntake = airDensity * displacementCc * 1e-6 * ve * 1000; // g
  const airFlow = airPerIntake * (rpm / 120); // g/s, 4-stroke
  return ((airFlow / 14.7) / 745) * 3600; // L/h of petrol
}
