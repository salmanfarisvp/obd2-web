"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Elm327, Sample } from "@/lib/obd/elm";
import { summarize, Totals } from "@/lib/rideSummary";
import { supabase, Reading, Ride } from "@/lib/supabase";

// Lives in the root layout so the adapter connection and an in-progress ride
// survive navigating between pages.
//
// With the adapter connected, rides are automatic: one starts when the engine
// starts and is saved when the power goes (adapter disconnects or ECU goes
// silent), or after the engine has been off for a while with the ignition on.

const PENDING_READINGS_KEY = "pending-readings";
const PENDING_RIDES_KEY = "pending-rides";
const SAMPLE_MS = 1000;
const FLUSH_MS = 5000;
const RECONNECT_MS = 5000;
// ECU stopped answering: ignition is off, so the ride is over.
const ECU_SILENT_MS = 10_000;
// ECU answering but RPM 0: engine off with ignition on (or stalled). Allow a restart.
const ENGINE_OFF_MS = 60_000;
// Fuel level rise (percentage points) between rides that counts as a fill-up.
const FILL_JUMP_PCT = 10;

export type Fix = { lat: number; lon: number; speed: number | null; accuracy: number };
export type Phase = "idle" | "waiting" | "recording";
type LinkState = "none" | "connecting" | "connected" | "reconnecting";
type RideRow = Partial<Ride> & { id: string };
type ActiveRide = { base: RideRow; rows: Reading[]; manual: boolean; lastRunningAt: number; fuelChecked: boolean };
export type FillPrompt = { vehicle: string; fromPct: number; toPct: number; at: string };
const fuelLevelKey = (vehicle: string) => `fuel-level:${vehicle}`;
export type SavedRide = { id: string; started_at: string; ended_at: string; distance_km: number };

function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function RecorderProvider({ children }: { children: React.ReactNode }) {
  const [link, setLink] = useState<LinkState>("none");
  const [adapter, setAdapter] = useState<string | null>(null);
  const [ecuOk, setEcuOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vehicle, setVehicleState] = useState("Suzuki Access 125");
  const [phase, setPhase] = useState<Phase>("idle");
  const [rideStartedAt, setRideStartedAt] = useState<string | null>(null);
  const [live, setLive] = useState<Sample>({});
  const [fix, setFix] = useState<Fix | null>(null);
  const [stats, setStats] = useState<Totals>(summarize([]));
  const [dtcs, setDtcs] = useState<string[] | null>(null);
  const [unsent, setUnsent] = useState(0);
  const [lastSaved, setLastSaved] = useState<SavedRide | null>(null);
  const [fillPrompt, setFillPrompt] = useState<FillPrompt | null>(null);
  const lastFuelLevel = useRef<number | null>(null);

  const elmRef = useRef<Elm327 | null>(null);
  const reconnecting = useRef<Elm327 | null>(null);
  const rideRef = useRef<ActiveRide | null>(null);
  // The ride that just ended, kept so an engine restart soon after continues it (see startRide).
  const lastEnded = useRef<{ ride: ActiveRide; endedAt: number } | null>(null);
  const mergeGapMin = useRef(10);
  const loopRunning = useRef(false);
  const waitForEngineOff = useRef(false);
  const ecuSilentSince = useRef<number | null>(null);
  const fixRef = useRef<Fix | null>(null);
  const gpsWatch = useRef<number | null>(null);
  const readingsQueue = useRef<Reading[]>([]);
  const ridesQueue = useRef<Record<string, RideRow>>({});
  const flushing = useRef(false);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const vehicleRef = useRef(vehicle);
  const dtcsRef = useRef<string[] | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("vehicle-name");
      if (saved) setVehicle(saved);
    } catch {}
    supabase.from("profiles").select("merge_gap_min").maybeSingle().then(({ data }) => {
      if (data && typeof data.merge_gap_min === "number") mergeGapMin.current = data.merge_gap_min;
    });
    readingsQueue.current = load<Reading[]>(PENDING_READINGS_KEY, []);
    ridesQueue.current = load<Record<string, RideRow>>(PENDING_RIDES_KEY, {});
    updateUnsent();
    flush();
    const timer = setInterval(flush, FLUSH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && (elmRef.current || rideRef.current)) requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      elmRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setVehicle(v: string) {
    vehicleRef.current = v;
    setVehicleState(v);
    try {
      localStorage.setItem("vehicle-name", v);
    } catch {}
  }

  function updateUnsent() {
    setUnsent(readingsQueue.current.length + Object.keys(ridesQueue.current).length);
  }

  function queueRide(row: RideRow) {
    ridesQueue.current[row.id] = { ...ridesQueue.current[row.id], ...row };
    save(PENDING_RIDES_KEY, ridesQueue.current);
    updateUnsent();
  }

  /** Upload queued rides first (readings reference them), then readings. Safe to call any time. */
  async function flush() {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const rides = Object.values(ridesQueue.current);
      if (rides.length) {
        const { error } = await supabase.from("rides").upsert(rides);
        if (error) return;
        for (const r of rides) if (ridesQueue.current[r.id] === r) delete ridesQueue.current[r.id];
        save(PENDING_RIDES_KEY, ridesQueue.current);
      }
      const rows = readingsQueue.current;
      if (rows.length) {
        readingsQueue.current = [];
        const { error } = await supabase.from("readings").insert(rows);
        if (error) readingsQueue.current = rows.concat(readingsQueue.current);
        save(PENDING_READINGS_KEY, readingsQueue.current);
      }
    } finally {
      flushing.current = false;
      updateUnsent();
    }
  }

  async function requestWakeLock() {
    try {
      wakeLock.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {}
  }

  function startGps() {
    if (gpsWatch.current !== null || !navigator.geolocation) return;
    gpsWatch.current = navigator.geolocation.watchPosition(
      (p) => {
        const f: Fix = { lat: p.coords.latitude, lon: p.coords.longitude, speed: p.coords.speed, accuracy: p.coords.accuracy };
        fixRef.current = f;
        setFix(f);
      },
      (e) => setError(`GPS: ${e.message}`),
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  }

  function attach(elm: Elm327) {
    elm.transport.onDisconnect = () => {
      // Adapter lost power with the scooter: save the ride now, then keep trying to get it back.
      elmRef.current = null;
      setAdapter(null);
      setEcuOk(false);
      if (rideRef.current && !rideRef.current.manual) endRide();
      autoReconnect(elm);
    };
    elmRef.current = elm;
    setAdapter(elm.transport.name);
    setLink("connected");
    ecuSilentSince.current = null;
    requestWakeLock();
    startGps();
    runLoop();
  }

  async function connect() {
    setError(null);
    reconnecting.current = null;
    setLink("connecting");
    const elm = new Elm327();
    try {
      await elm.connect();
      attach(elm);
      elm.readDtcs().then((codes) => {
        dtcsRef.current = codes;
        setDtcs(codes);
      }, () => {});
    } catch (e) {
      elm.disconnect();
      setLink("none");
      setError((e as Error).message);
    }
  }

  async function autoReconnect(elm: Elm327) {
    setLink("reconnecting");
    reconnecting.current = elm;
    while (reconnecting.current === elm) {
      try {
        await elm.reconnect();
        if (reconnecting.current !== elm) return elm.disconnect();
        reconnecting.current = null;
        attach(elm);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, RECONNECT_MS));
      }
    }
  }

  /** Give up on automatic reconnection and forget the adapter. */
  function disconnect() {
    const elm = elmRef.current;
    elmRef.current = null;
    reconnecting.current = null;
    elm?.disconnect();
    setAdapter(null);
    setEcuOk(false);
    setLink("none");
    if (rideRef.current && !rideRef.current.manual) endRide();
  }

  function startRide(manual: boolean) {
    // Engine started again soon after the last ride on this vehicle: continue it, the gap becomes a break.
    const last = lastEnded.current;
    lastEnded.current = null;
    if (
      !manual && last && mergeGapMin.current > 0 &&
      last.ride.base.vehicle_name === vehicleRef.current &&
      Date.now() - last.endedAt < mergeGapMin.current * 60_000
    ) {
      rideRef.current = { ...last.ride, lastRunningAt: Date.now() };
      queueRide({ id: last.ride.base.id, ended_at: null });
      setRideStartedAt(last.ride.base.started_at!);
      setStats(summarize(last.ride.rows));
      setPhase("recording");
      return;
    }
    const base: RideRow = {
      id: crypto.randomUUID(),
      vehicle_name: vehicleRef.current,
      started_at: new Date().toISOString(),
      obd_connected: !manual,
    };
    rideRef.current = { base, rows: [], manual, lastRunningAt: Date.now(), fuelChecked: false };
    queueRide(base);
    setRideStartedAt(base.started_at!);
    setStats(summarize([]));
    setPhase("recording");
    flush().then(() => {
      const codes = dtcsRef.current;
      if (codes?.length) supabase.from("fault_codes").insert(codes.map((code) => ({ ride_id: base.id, code }))).then(() => {});
    });
  }

  function endRide() {
    const ride = rideRef.current;
    if (!ride) return;
    rideRef.current = null;
    setRideStartedAt(null);
    if (lastFuelLevel.current !== null) save(fuelLevelKey(ride.base.vehicle_name!), lastFuelLevel.current);
    setPhase(elmRef.current ? "waiting" : "idle");
    if (!ride.rows.length) {
      // Nothing was logged (engine never really ran); drop the empty ride.
      delete ridesQueue.current[ride.base.id];
      save(PENDING_RIDES_KEY, ridesQueue.current);
      supabase.from("rides").delete().eq("id", ride.base.id).then(() => {});
      updateUnsent();
      return;
    }
    const totals = summarize(ride.rows);
    const ended_at = ride.rows[ride.rows.length - 1].ts;
    queueRide({ ...ride.base, ...totals, ended_at });
    if (!ride.manual) lastEnded.current = { ride, endedAt: Date.now() };
    setLastSaved({ id: ride.base.id, started_at: ride.base.started_at!, ended_at, distance_km: totals.distance_km });
    flush();
  }

  /** Manual start, for GPS-only rides without the adapter. */
  function start() {
    setError(null);
    if (rideRef.current) return;
    requestWakeLock();
    startGps();
    startRide(true);
    runLoop();
  }

  function stop() {
    const ride = rideRef.current;
    if (!ride) return;
    // Don't let an engine that is still running start a new ride straight away.
    if (!ride.manual) waitForEngineOff.current = true;
    endRide();
    // Ended on purpose: the next engine start is a new ride, not a continuation.
    lastEnded.current = null;
  }

  function logReading(ride: ActiveRide, sample: Sample) {
    const f = fixRef.current;
    const gpsKmh = f?.speed != null && f.speed >= 0 ? f.speed * 3.6 : null;
    const row: Reading = {
      ride_id: ride.base.id,
      ts: new Date().toISOString(),
      lat: f?.lat ?? null,
      lon: f?.lon ?? null,
      gps_speed: gpsKmh,
      rpm: ride.manual ? null : sample.rpm ?? null,
      speed: ride.manual ? null : sample.speed ?? null,
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
      ...(sample.fuel_level !== undefined && { fuel_level: sample.fuel_level }),
    };
    ride.rows.push(row);
    readingsQueue.current.push(row);
  }

  async function runLoop() {
    if (loopRunning.current) return;
    loopRunning.current = true;
    if (!rideRef.current) setPhase(elmRef.current ? "waiting" : "idle");
    try {
      while (elmRef.current || rideRef.current) {
        const tickStart = Date.now();
        const elm = elmRef.current;
        let sample: Sample = {};
        let engineOn = false;

        if (elm) {
          try {
            const res = await elm.poll();
            sample = res.sample;
            engineOn = res.ecuOk && (sample.rpm ?? 0) > 0;
            setEcuOk(res.ecuOk);
            ecuSilentSince.current = res.ecuOk ? null : ecuSilentSince.current ?? Date.now();
          } catch {}
          if (!engineOn) waitForEngineOff.current = false;
          if (engineOn && !rideRef.current && !waitForEngineOff.current) startRide(false);
        }

        const ride = rideRef.current;
        if (sample.fuel_level !== undefined) {
          lastFuelLevel.current = sample.fuel_level;
          // Compare the first fuel reading of a ride with where the last ride ended.
          if (ride && !ride.manual && !ride.fuelChecked) {
            ride.fuelChecked = true;
            const vehicleName = ride.base.vehicle_name!;
            const before = load<number | null>(fuelLevelKey(vehicleName), null);
            if (before !== null && sample.fuel_level - before >= FILL_JUMP_PCT) {
              setFillPrompt({ vehicle: vehicleName, fromPct: before, toPct: sample.fuel_level, at: new Date().toISOString() });
            }
          }
        }
        if (ride?.manual) {
          logReading(ride, sample);
        } else if (ride && engineOn) {
          logReading(ride, sample);
          ride.lastRunningAt = Date.now();
        } else if (ride) {
          const silent = ecuSilentSince.current !== null && Date.now() - ecuSilentSince.current > ECU_SILENT_MS;
          if (silent || Date.now() - ride.lastRunningAt > ENGINE_OFF_MS) endRide();
        }

        setLive(sample);
        if (rideRef.current) setStats(summarize(rideRef.current.rows));

        const wait = SAMPLE_MS - (Date.now() - tickStart);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      loopRunning.current = false;
      if (!rideRef.current) setPhase(elmRef.current ? "waiting" : "idle");
      if (!elmRef.current && !rideRef.current) wakeLock.current?.release().catch(() => {});
    }
  }

  const value: Recorder = {
    link, adapter, ecuOk, error, vehicle, setVehicle, phase, rideStartedAt, live, fix, stats, dtcs, unsent,
    lastSaved, fillPrompt, dismissFillPrompt: () => setFillPrompt(null), connect, disconnect, start, stop,
  };
  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}

type Recorder = {
  link: LinkState;
  adapter: string | null;
  ecuOk: boolean;
  error: string | null;
  vehicle: string;
  setVehicle: (v: string) => void;
  phase: Phase;
  rideStartedAt: string | null;
  live: Sample;
  fix: Fix | null;
  stats: Totals;
  dtcs: string[] | null;
  unsent: number;
  lastSaved: SavedRide | null;
  fillPrompt: FillPrompt | null;
  dismissFillPrompt: () => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  start: () => void;
  stop: () => void;
};

const RecorderContext = createContext<Recorder | null>(null);

export function useRecorder() {
  const ctx = useContext(RecorderContext);
  if (!ctx) throw new Error("useRecorder must be used inside RecorderProvider");
  return ctx;
}
