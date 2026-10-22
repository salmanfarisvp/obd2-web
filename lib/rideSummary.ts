import { supabase, Ride, Reading } from "./supabase";
import { haversineKm } from "./geo";

// A ride with no new readings for this long was abandoned (reload, closed app) rather than still recording.
const ABANDONED_MS = 2 * 60 * 1000;
// Ignore gaps longer than this when integrating speed, so a pause in logging doesn't add phantom distance.
const MAX_STEP_S = 5;
// At or below this the scooter counts as stopped (OBD speed reads 0-1 km/h at idle).
const MOVING_KMH = 2;
// A stationary spell must last this long after moving to count as a stop.
const STOP_MIN_S = 5;

export async function fetchReadings(rideId: string) {
  const rows: Reading[] = [];
  const page = 1000; // Supabase caps responses at 1000 rows by default
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from("readings")
      .select("*")
      .eq("ride_id", rideId)
      .order("ts")
      .range(from, from + page - 1);
    if (error) throw error;
    rows.push(...(data as Reading[]));
    if (data.length < page) return rows;
  }
}

export type Totals = Pick<Ride, "max_rpm" | "max_coolant" | "fuel_l"> & {
  distance_km: number;
  duration_s: number;
  avg_speed: number;
  max_speed: number;
  moving_s: number;
  idle_s: number;
  stops: number;
};

/** Ride totals from its readings; used live while recording and to finish rides afterwards. */
export function summarize(readings: Reading[]): Totals {
  if (!readings.length) {
    return { distance_km: 0, duration_s: 0, avg_speed: 0, max_speed: 0, max_rpm: null, max_coolant: null, fuel_l: null, moving_s: 0, idle_s: 0, stops: 0 };
  }
  let obdKm = 0, gpsKm = 0, fuelL = 0, maxSpeed = 0, maxRpm = 0, maxCoolant = 0;
  let movingS = 0, idleS = 0, stops = 0, stillS = 0, hasMoved = false;
  let prevGps: Reading | null = null;

  readings.forEach((r, i) => {
    const speed = r.speed ?? r.gps_speed ?? 0;
    maxSpeed = Math.max(maxSpeed, speed);
    maxRpm = Math.max(maxRpm, r.rpm ?? 0);
    maxCoolant = Math.max(maxCoolant, r.coolant ?? 0);
    if (i > 0) {
      const dtS = Math.min((Date.parse(r.ts) - Date.parse(readings[i - 1].ts)) / 1000, MAX_STEP_S);
      if (r.speed !== null) obdKm += (r.speed * dtS) / 3600;
      fuelL += ((r.fuel_rate ?? 0) * dtS) / 3600;

      // Engine off (RPM 0) counts as neither riding nor idling. GPS-only rides have no RPM.
      const engineOn = r.rpm === null || r.rpm > 0;
      if (speed > MOVING_KMH) {
        movingS += dtS;
        hasMoved = true;
        stillS = 0;
      } else if (engineOn) {
        idleS += dtS;
        if (hasMoved && stillS < STOP_MIN_S && stillS + dtS >= STOP_MIN_S) stops++;
        stillS += dtS;
      }
    }
    if (r.lat !== null && r.lon !== null) {
      if (prevGps) {
        const km = haversineKm(prevGps.lat!, prevGps.lon!, r.lat, r.lon);
        const hours = (Date.parse(r.ts) - Date.parse(prevGps.ts)) / 3_600_000;
        if (hours > 0 && km / hours < 150) gpsKm += km; // skip GPS jumps
      }
      prevGps = r;
    }
  });

  const durationS = (Date.parse(readings[readings.length - 1].ts) - Date.parse(readings[0].ts)) / 1000;
  const distance = obdKm > 0 ? obdKm : gpsKm;
  return {
    distance_km: distance,
    duration_s: Math.round(durationS),
    avg_speed: durationS ? distance / (durationS / 3600) : 0,
    max_speed: maxSpeed,
    max_rpm: maxRpm || null,
    max_coolant: maxCoolant || null,
    fuel_l: fuelL || null,
    moving_s: Math.round(movingS),
    idle_s: Math.round(idleS),
    stops,
  };
}

/**
 * For a ride that was never stopped, compute its totals from the saved readings.
 * If it has gone quiet, save them and close the ride so this only happens once.
 * Finished rides from before riding/idle time existed just get those filled in.
 */
export async function completeRide(ride: Ride, readings?: Reading[]): Promise<Ride> {
  if (ride.ended_at !== null && ride.moving_s !== null) return ride;
  const rows = readings ?? (await fetchReadings(ride.id));
  const totals = summarize(rows);
  if (ride.ended_at !== null) {
    const times = { moving_s: totals.moving_s, idle_s: totals.idle_s, stops: totals.stops };
    await supabase.from("rides").update(times).eq("id", ride.id);
    return { ...ride, ...times };
  }
  const lastTs = rows.length ? rows[rows.length - 1].ts : ride.started_at;
  if (Date.now() - Date.parse(lastTs) < ABANDONED_MS) return { ...ride, ...totals };

  const finished = { ...totals, ended_at: lastTs };
  await supabase.from("rides").update(finished).eq("id", ride.id);
  return { ...ride, ...finished };
}
