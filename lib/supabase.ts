import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost",
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "missing-key",
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
  moving_s: number | null;
  idle_s: number | null;
  stops: number | null;
  note: string | null;
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
  fuel_level?: number | null;
};

export type FaultCode = { id: number; ride_id: string; code: string; detected_at: string };

export type Profile = { user_id: string; currency: string; fuel_price: number | null };
export type Vehicle = { id: string; name: string; tank_l: number | null };
export type FuelLog = {
  id: string;
  vehicle_name: string;
  filled_at: string;
  litres: number;
  amount: number | null;
  price_per_l: number | null;
  full_tank: boolean;
  source: "manual" | "auto";
  note: string | null;
};
