"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Elm327, Sample } from "@/lib/obd/elm";
import { haversineKm } from "@/lib/geo";
import { supabase, Reading } from "@/lib/supabase";

// Lives in the root layout so the adapter connection and an in-progress ride
// survive navigating between pages.

const PENDING_KEY = "pending-readings";
const SAMPLE_MS = 1000;
const FLUSH_MS = 5000;

export type Fix = { lat: number; lon: number; speed: number | null; accuracy: number };
export type Stats = { distanceKm: number; gpsKm: number; maxSpeed: number; maxRpm: number; maxCoolant: number; fuelL: number; seconds: number };
const emptyStats: Stats = { distanceKm: 0, gpsKm: 0, maxSpeed: 0, maxRpm: 0, maxCoolant: 0, fuelL: 0, seconds: 0 };

function loadPending(): Reading[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function savePending(rows: Reading[]) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(rows));
  } catch {}
}

export function RecorderProvider({ children }: { children: React.ReactNode }) {
  const elmRef = useRef<Elm327 | null>(null);
  const [adapter, setAdapter] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vehicle, setVehicle] = useState("Suzuki Access 125");
  const [rideId, setRideId] = useState<string | null>(null);
  const [live, setLive] = useState<Sample>({});
  const [fix, setFix] = useState<Fix | null>(null);
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [dtcs, setDtcs] = useState<string[] | null>(null);
  const [unsent, setUnsent] = useState(0);
  const [phase, setPhase] = useState<"idle" | "recording" | "saving" | "saved">("idle");

  const recording = useRef(false);
  const fixRef = useRef<Fix | null>(null);
  const lastFixRef = useRef<Fix | null>(null);
  const bufferRef = useRef<Reading[]>([]);
  const statsRef = useRef<Stats>(emptyStats);
  const wakeLock = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("vehicle-name");
      if (saved) setVehicle(saved);
    } catch {}
    bufferRef.current = loadPending();
    setUnsent(bufferRef.current.length);
    if (bufferRef.current.length) flush();
    return () => {
      recording.current = false;
      elmRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    setError(null);
    setConnecting(true);
    const elm = new Elm327();
    elm.transport.onDisconnect = () => {
      setAdapter(null);
      elmRef.current = null;
    };
    try {
      await elm.connect();
      elmRef.current = elm;
      setAdapter(elm.transport.name);
      setLive(await elm.poll());
      setDtcs(await elm.readDtcs().catch(() => null));
    } catch (e) {
      elm.disconnect();
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  async function flush() {
    const rows = bufferRef.current;
    if (!rows.length) return;
    bufferRef.current = [];
    const { error } = await supabase.from("readings").insert(rows);
    if (error) bufferRef.current = rows.concat(bufferRef.current);
    savePending(bufferRef.current);
    setUnsent(bufferRef.current.length);
  }

  async function requestWakeLock() {
    try {
      wakeLock.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {}
  }

  async function start() {
    setError(null);
    try {
      localStorage.setItem("vehicle-name", vehicle);
    } catch {}
    const { data, error } = await supabase
      .from("rides")
      .insert({ vehicle_name: vehicle, obd_connected: !!elmRef.current })
      .select("id")
      .single();
    if (error) return setError(error.message);
    const id = data.id as string;
    setRideId(id);

    if (dtcs?.length) await supabase.from("fault_codes").insert(dtcs.map((code) => ({ ride_id: id, code })));

    statsRef.current = { ...emptyStats };
    lastFixRef.current = null;
    recording.current = true;
    setPhase("recording");
    requestWakeLock();
    document.addEventListener("visibilitychange", onVisible);

    const watch = navigator.geolocation?.watchPosition(
      (p) => {
        const f: Fix = { lat: p.coords.latitude, lon: p.coords.longitude, speed: p.coords.speed, accuracy: p.coords.accuracy };
        fixRef.current = f;
        setFix(f);
        if (f.accuracy <= 30) {
          const prev = lastFixRef.current;
          if (prev) statsRef.current.gpsKm += haversineKm(prev.lat, prev.lon, f.lat, f.lon);
          lastFixRef.current = f;
        }
      },
      (e) => setError(`GPS: ${e.message}`),
      { enableHighAccuracy: true, maximumAge: 0 },
    );

    const flushTimer = setInterval(flush, FLUSH_MS);
    const startedAt = Date.now();
    let lastTick = startedAt;

    while (recording.current) {
      const tickStart = Date.now();
      let sample: Sample = {};
      if (elmRef.current) {
        try {
          sample = await elmRef.current.poll();
        } catch {}
      }
      const now = Date.now();
      const dtH = (now - lastTick) / 3_600_000;
      lastTick = now;

      const s = statsRef.current;
      const f = fixRef.current;
      const gpsKmh = f?.speed != null && f.speed >= 0 ? f.speed * 3.6 : null;
      const speed = sample.speed ?? gpsKmh ?? 0;
      if (sample.speed !== undefined) s.distanceKm += sample.speed * dtH;
      s.fuelL += (sample.fuel_rate ?? 0) * dtH;
      s.maxSpeed = Math.max(s.maxSpeed, speed);
      s.maxRpm = Math.max(s.maxRpm, sample.rpm ?? 0);
      s.maxCoolant = Math.max(s.maxCoolant, sample.coolant ?? 0);
      s.seconds = (now - startedAt) / 1000;

      bufferRef.current.push({
        ride_id: id,
        ts: new Date(now).toISOString(),
        lat: f?.lat ?? null,
        lon: f?.lon ?? null,
        gps_speed: gpsKmh,
        rpm: sample.rpm ?? null,
        speed: sample.speed ?? null,
        coolant: sample.coolant ?? null,
        intake_temp: sample.intake_temp ?? null,
        throttle: sample.throttle ?? null,
        load: sample.load ?? null,
        map_kpa: sample.map_kpa ?? null,
        timing: sample.timing ?? null,
        stft: sample.stft ?? null,
        ltft: sample.ltft ?? null,
        voltage: sample.voltage ?? null,
        fuel_rate: sample.fuel_rate ?? null,
      });
      setLive(sample);
      setStats({ ...s });

      const wait = SAMPLE_MS - (Date.now() - tickStart);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    setPhase("saving");
    clearInterval(flushTimer);
    if (watch !== undefined) navigator.geolocation.clearWatch(watch);
    document.removeEventListener("visibilitychange", onVisible);
    wakeLock.current?.release().catch(() => {});
    await flush();

    const s = statsRef.current;
    // OBD speed integrates cleanly through tunnels and GPS drift; fall back to GPS without the adapter.
    const distance = s.distanceKm > 0 ? s.distanceKm : s.gpsKm;
    await supabase
      .from("rides")
      .update({
        ended_at: new Date().toISOString(),
        duration_s: Math.round(s.seconds),
        distance_km: distance,
        avg_speed: s.seconds ? distance / (s.seconds / 3600) : 0,
        max_speed: s.maxSpeed,
        max_rpm: s.maxRpm || null,
        max_coolant: s.maxCoolant || null,
        fuel_l: s.fuelL || null,
      })
      .eq("id", id);
    setPhase("saved");
  }

  function onVisible() {
    if (document.visibilityState === "visible" && recording.current) requestWakeLock();
  }

  function stop() {
    recording.current = false;
  }

  const value = {
    adapter, connecting, error, vehicle, setVehicle, rideId, live, fix, stats, dtcs, unsent, phase,
    connect, start, stop,
  };
  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}

type Recorder = {
  adapter: string | null;
  connecting: boolean;
  error: string | null;
  vehicle: string;
  setVehicle: (v: string) => void;
  rideId: string | null;
  live: Sample;
  fix: Fix | null;
  stats: Stats;
  dtcs: string[] | null;
  unsent: number;
  phase: "idle" | "recording" | "saving" | "saved";
  connect: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => void;
};

const RecorderContext = createContext<Recorder | null>(null);

export function useRecorder() {
  const ctx = useContext(RecorderContext);
  if (!ctx) throw new Error("useRecorder must be used inside RecorderProvider");
  return ctx;
}
