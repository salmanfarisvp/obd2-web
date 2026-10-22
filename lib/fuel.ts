import { supabase, FuelLog, Profile, Ride, Vehicle } from "./supabase";

export const DEFAULT_CURRENCY = "₹";
// Fill-ups (in tank-fulls) needed before partial-fill mileage is trusted.
const CONFIDENT_TANKS = 3;

export type FuelData = { profile: Profile | null; vehicles: Vehicle[]; logs: FuelLog[] };

export async function loadFuelData(): Promise<FuelData> {
  const [p, v, l] = await Promise.all([
    supabase.from("profiles").select("*").maybeSingle(),
    supabase.from("vehicles").select("*").order("name"),
    supabase.from("fuel_logs").select("*").order("filled_at"),
  ]);
  return {
    profile: (p.data as Profile | null) ?? null,
    vehicles: (v.data as Vehicle[]) ?? [],
    logs: (l.data as FuelLog[]) ?? [],
  };
}

export function money(currency: string, value: number) {
  return `${currency}${value.toFixed(value >= 100 ? 0 : 2)}`;
}

/** Petrol price for a moment: the latest fill-up price before it, else the profile price. */
export function priceAt(data: FuelData, iso: string): number | null {
  let price: number | null = null;
  for (const log of data.logs) {
    if (log.filled_at > iso) break;
    if (log.price_per_l) price = log.price_per_l;
  }
  return price ?? data.profile?.fuel_price ?? null;
}

export type Mileage = {
  kmPerL: number;
  km: number;
  litres: number;
  fills: number;
  method: "full" | "partial";
  confident: boolean;
  /** Real fuel ÷ estimated fuel over the same rides; scales the engine-based estimates. */
  factor: number | null;
};

/**
 * Real mileage from the fuel log. Fuel bought between two fill-ups is what the rides between
 * them burned. Full-to-full is exact; with partial fills the unknown tank level at each end
 * blurs it by up to a tankful, so it needs a few tankfuls of history to be trustworthy.
 */
export function realMileage(vehicle: string, rides: Ride[], data: FuelData): Mileage | null {
  const logs = data.logs.filter((l) => l.vehicle_name === vehicle);
  const full = logs.filter((l) => l.full_tank);
  const tank = data.vehicles.find((v) => v.name === vehicle)?.tank_l ?? 5;

  const method = full.length >= 2 ? "full" : "partial";
  const [start, end] = method === "full" ? [full[0], full[full.length - 1]] : [logs[0], logs[logs.length - 1]];
  if (!start || !end || start === end) return null;

  const litres = logs.filter((l) => l.filled_at > start.filled_at && l.filled_at <= end.filled_at).reduce((s, l) => s + l.litres, 0);
  const between = rides.filter((r) => r.vehicle_name === vehicle && r.started_at >= start.filled_at && r.started_at < end.filled_at);
  const km = between.reduce((s, r) => s + (r.distance_km ?? 0), 0);
  const estimated = between.reduce((s, r) => s + (r.fuel_l ?? 0), 0);
  if (km <= 0 || litres <= 0) return null;

  return {
    kmPerL: km / litres,
    km,
    litres,
    fills: logs.filter((l) => l.filled_at >= start.filled_at && l.filled_at <= end.filled_at).length,
    method,
    confident: method === "full" || litres >= CONFIDENT_TANKS * tank,
    factor: estimated > 0 ? litres / estimated : null,
  };
}

/** Correction for engine-based estimates, once the fuel log is reliable enough to trust it. */
export const calibration = (mileage: Mileage | null) => (mileage?.confident && mileage.factor) || null;

/** Fuel a ride used: the engine estimate (calibrated when possible), or real mileage alone for GPS-only rides. */
export function rideFuel(ride: Ride, mileage: Mileage | null): number | null {
  if (ride.fuel_l !== null) return ride.fuel_l * (calibration(mileage) ?? 1);
  if (mileage && ride.distance_km) return ride.distance_km / mileage.kmPerL;
  return null;
}

export function rideCost(ride: Ride, mileage: Mileage | null, data: FuelData): number | null {
  const litres = rideFuel(ride, mileage);
  const price = priceAt(data, ride.started_at);
  return litres !== null && price !== null ? litres * price : null;
}
