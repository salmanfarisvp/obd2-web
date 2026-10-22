"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import RequireAuth from "@/components/RequireAuth";
import { Elm327, Sample } from "@/lib/obd/elm";
import { haversineKm, formatDuration } from "@/lib/geo";
import { supabase, Reading } from "@/lib/supabase";

const PENDING_KEY = "pending-readings";
const SAMPLE_MS = 1000;
const FLUSH_MS = 5000;

type Fix = { lat: number; lon: number; speed: number | null; accuracy: number };
type Stats = { distanceKm: number; gpsKm: number; maxSpeed: number; maxRpm: number; maxCoolant: number; fuelL: number; seconds: number };
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

function RideRecorder() {
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

  const isRecording = phase === "recording" || phase === "saving";
  const distance = stats.distanceKm > 0 ? stats.distanceKm : stats.gpsKm;
  const fmt = (v: number | undefined, d = 0) => (v === undefined ? "–" : v.toFixed(d));

  return (
    <>
      <h1>Ride</h1>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            {adapter ? <span className="pill ok">● {adapter}</span> : <span className="pill">OBD not connected</span>}{" "}
            {fix ? (
              <span className={`pill ${fix.accuracy <= 30 ? "ok" : "warn"}`}>GPS ±{Math.round(fix.accuracy)} m</span>
            ) : (
              <span className="pill">GPS waiting</span>
            )}
            {unsent > 0 && <span className="pill warn"> {unsent} unsent</span>}
          </div>
          {!adapter && (
            <button onClick={connect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect OBD"}
            </button>
          )}
        </div>

        {!isRecording && (
          <>
            <label>Vehicle</label>
            <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
            <div className="row" style={{ marginTop: 16 }}>
              <button className="primary" onClick={start}>
                {adapter ? "Start ride" : "Start ride (GPS only)"}
              </button>
            </div>
          </>
        )}
        {isRecording && (
          <div className="row" style={{ marginTop: 16 }}>
            <button className="danger" onClick={stop} disabled={phase === "saving"}>
              {phase === "saving" ? "Saving…" : "Stop ride"}
            </button>
            <span className="muted">{formatDuration(stats.seconds)}</span>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {rideId && phase === "saved" && (
          <p>
            Ride saved. <Link href={`/rides/${rideId}`} style={{ color: "var(--accent)" }}>View it →</Link>
          </p>
        )}
      </div>

      <h2>Live</h2>
      <div className="grid">
        <div className="card stat big"><div className="label">Speed</div><div className="value">{fmt(live.speed ?? (fix?.speed != null ? fix.speed * 3.6 : undefined))}<span className="unit">km/h</span></div></div>
        <div className="card stat big"><div className="label">RPM</div><div className="value">{fmt(live.rpm)}</div></div>
        <div className="card stat"><div className="label">Coolant</div><div className="value">{fmt(live.coolant)}<span className="unit">°C</span></div></div>
        <div className="card stat"><div className="label">Throttle</div><div className="value">{fmt(live.throttle)}<span className="unit">%</span></div></div>
        <div className="card stat"><div className="label">Load</div><div className="value">{fmt(live.load)}<span className="unit">%</span></div></div>
        <div className="card stat"><div className="label">Intake air</div><div className="value">{fmt(live.intake_temp)}<span className="unit">°C</span></div></div>
        <div className="card stat"><div className="label">MAP</div><div className="value">{fmt(live.map_kpa)}<span className="unit">kPa</span></div></div>
        <div className="card stat"><div className="label">Battery</div><div className="value">{fmt(live.voltage, 1)}<span className="unit">V</span></div></div>
        <div className="card stat"><div className="label">Fuel rate (est.)</div><div className="value">{fmt(live.fuel_rate, 2)}<span className="unit">L/h</span></div></div>
      </div>

      <h2>This ride</h2>
      <div className="grid">
        <div className="card stat"><div className="label">Distance</div><div className="value">{distance.toFixed(2)}<span className="unit">km</span></div></div>
        <div className="card stat"><div className="label">Max speed</div><div className="value">{stats.maxSpeed.toFixed(0)}<span className="unit">km/h</span></div></div>
        <div className="card stat"><div className="label">Fuel used (est.)</div><div className="value">{stats.fuelL.toFixed(2)}<span className="unit">L</span></div></div>
        <div className="card stat"><div className="label">Economy (est.)</div><div className="value">{stats.fuelL > 0.01 ? (distance / stats.fuelL).toFixed(1) : "–"}<span className="unit">km/L</span></div></div>
      </div>

      {dtcs && (
        <>
          <h2>Fault codes</h2>
          <div className="card">
            {dtcs.length ? dtcs.map((c) => <span key={c} className="pill bad" style={{ marginRight: 6 }}>{c}</span>) : <span className="pill ok">No stored codes</span>}
          </div>
        </>
      )}
    </>
  );
}

export default function RidePage() {
  return (
    <RequireAuth>
      <RideRecorder />
    </RequireAuth>
  );
}
