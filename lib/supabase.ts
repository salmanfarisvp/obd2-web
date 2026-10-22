import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "missing-key",
);

export type Ride = {
  id: string;
  vehicle_name: string;
  started_at: string;
  ended_at: string | null;
  distance_km: number | null;
  duration_s: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  max_rpm: number | null;
  max_coolant: number | null;
  fuel_l: number | null;
  obd_connected: boolean;
};

export type Reading = {
  ride_id: string;
  ts: string;
  lat: number | null;
  lon: number | null;
  gps_speed: number | null;
  rpm: number | null;
  speed: number | null;
  coolant: number | null;
  intake_temp: number | null;
  throttle: number | null;
  load: number | null;
  map_kpa: number | null;
  timing: number | null;
  stft: number | null;
  ltft: number | null;
  voltage: number | null;
  fuel_rate: number | null;
};

export type FaultCode = { id: number; ride_id: string; code: string; detected_at: string };
