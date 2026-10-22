"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import RequireAuth from "@/components/RequireAuth";
import RideNote from "@/components/RideNote";
import { useRecorder } from "@/components/RecorderProvider";
import { formatDuration } from "@/lib/geo";
import { supabase, Vehicle } from "@/lib/supabase";

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function RideRecorder() {
  const {
    link, adapter, ecuOk, error, vehicle, setVehicle, phase, rideStartedAt, live, fix, stats, dtcs, unsent, lastSaved,
    fillPrompt, dismissFillPrompt, connect, disconnect, start, stop,
  } = useRecorder();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  useEffect(() => {
    supabase.from("vehicles").select("*").order("name").then(({ data }) => setVehicles((data as Vehicle[]) ?? []));
  }, []);
  const tank = vehicles.find((v) => v.name === fillPrompt?.vehicle)?.tank_l ?? null;
  const filledLitres = fillPrompt && tank ? ((fillPrompt.toPct - fillPrompt.fromPct) / 100) * tank : null;

  const fmt = (v: number | undefined, d = 0) => (v === undefined ? "–" : v.toFixed(d));
  const status =
    phase === "recording"
      ? `Recording since ${time(rideStartedAt!)}`
      : link === "reconnecting"
        ? "Adapter off. Reconnecting automatically when the scooter is switched on…"
        : link === "connecting"
          ? "Connecting…"
          : adapter
            ? ecuOk
              ? "Ready. The ride starts when the engine starts."
              : "Adapter connected. Turn the ignition on."
            : "Connect the adapter once; rides then start and save automatically.";

  return (
    <>
      <h1>Ride</h1>

      <div className="card">
        <div className="row">
          {adapter ? (
            <span className="pill ok">● {adapter}</span>
          ) : link === "reconnecting" ? (
            <span className="pill warn">● Reconnecting</span>
          ) : (
            <span className="pill">OBD not connected</span>
          )}
          {fix ? (
            <span className={`pill ${fix.accuracy <= 30 ? "ok" : "warn"}`}>GPS ±{Math.round(fix.accuracy)} m</span>
          ) : (
            <span className="pill">GPS waiting</span>
          )}
          {unsent > 0 && <span className="pill warn">{unsent} unsent</span>}
        </div>
        <p style={{ marginBottom: 0 }}>{status}</p>

        {phase !== "recording" && (
          <>
            <label>Vehicle</label>
            <input list="vehicle-names" value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
            <datalist id="vehicle-names">
              {vehicles.map((v) => <option key={v.id} value={v.name} />)}
            </datalist>
          </>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          {!adapter && link !== "connecting" && (
            <button className="primary" onClick={connect}>{link === "reconnecting" ? "Pick adapter again" : "Connect OBD"}</button>
          )}
          {(adapter || link === "reconnecting") && phase !== "recording" && <button onClick={disconnect}>Disconnect</button>}
          {!adapter && link !== "reconnecting" && phase !== "recording" && <button onClick={start}>Start GPS-only ride</button>}
          {phase === "recording" && <button className="danger" onClick={stop}>End ride now</button>}
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      {fillPrompt && (
        <div className="card" style={{ marginTop: 12, borderColor: "var(--ok)" }}>
          <p style={{ marginTop: 0 }}>
            ⛽ Looks like you filled up: the fuel gauge went from {fillPrompt.fromPct.toFixed(0)}% to {fillPrompt.toPct.toFixed(0)}%
            {filledLitres !== null ? ` (about ${filledLitres.toFixed(2)} L)` : ". Set the tank size in Profile to estimate litres"}.
          </p>
          <div className="row">
            <Link
              className="button primary"
              href={`/fuel?vehicle=${encodeURIComponent(fillPrompt.vehicle)}&at=${encodeURIComponent(fillPrompt.at)}&litres=${filledLitres?.toFixed(2) ?? ""}`}
              onClick={dismissFillPrompt}
            >
              Add to fuel log
            </Link>
            <button onClick={dismissFillPrompt}>Dismiss</button>
          </div>
        </div>
      )}

      {lastSaved && phase !== "recording" && (
        <>
          <h2>Last ride saved</h2>
          <div className="card">
            <p style={{ marginTop: 0 }}>
              {new Date(lastSaved.started_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })},{" "}
              {time(lastSaved.started_at)}–{time(lastSaved.ended_at)} · {lastSaved.distance_km.toFixed(1)} km ·{" "}
              <Link href={`/rides/${lastSaved.id}`} style={{ color: "var(--accent)" }}>View →</Link>
            </p>
            <RideNote key={lastSaved.id} rideId={lastSaved.id} initial={null} />
          </div>
        </>
      )}

      {(adapter || phase === "recording") && (
        <>
          <h2>Live</h2>
          <div className="grid">
            <div className="card stat big"><div className="label">Speed</div><div className="value">{fmt(live.speed ?? (fix?.speed != null ? fix.speed * 3.6 : undefined))}<span className="unit">km/h</span></div></div>
            {/* Engine readings only exist with the adapter; a GPS-only ride just shows speed. */}
            {adapter && (
              <>
                <div className="card stat big"><div className="label">RPM</div><div className="value">{fmt(live.rpm)}</div></div>
                <div className="card stat"><div className="label">Coolant</div><div className="value">{fmt(live.coolant)}<span className="unit">°C</span></div></div>
                <div className="card stat"><div className="label">Throttle</div><div className="value">{fmt(live.throttle)}<span className="unit">%</span></div></div>
                <div className="card stat"><div className="label">Load</div><div className="value">{fmt(live.load)}<span className="unit">%</span></div></div>
                <div className="card stat"><div className="label">Intake air</div><div className="value">{fmt(live.intake_temp)}<span className="unit">°C</span></div></div>
                <div className="card stat"><div className="label">MAP</div><div className="value">{fmt(live.map_kpa)}<span className="unit">kPa</span></div></div>
                <div className="card stat"><div className="label">Battery</div><div className="value">{fmt(live.voltage, 1)}<span className="unit">V</span></div></div>
                <div className="card stat"><div className="label">Fuel rate (est.)</div><div className="value">{fmt(live.fuel_rate, 2)}<span className="unit">L/h</span></div></div>
              </>
            )}
          </div>
        </>
      )}

      {phase === "recording" && (
        <>
          <h2>This ride</h2>
          <div className="grid">
            <div className="card stat"><div className="label">Distance</div><div className="value">{stats.distance_km.toFixed(2)}<span className="unit">km</span></div></div>
            <div className="card stat"><div className="label">Riding time</div><div className="value" style={{ fontSize: 20 }}>{formatDuration(stats.moving_s)}</div></div>
            <div className="card stat"><div className="label">Idle time</div><div className="value" style={{ fontSize: 20 }}>{formatDuration(stats.idle_s)}</div></div>
            <div className="card stat"><div className="label">Stops</div><div className="value">{stats.stops}</div></div>
            <div className="card stat"><div className="label">Max speed</div><div className="value">{stats.max_speed.toFixed(0)}<span className="unit">km/h</span></div></div>
            <div className="card stat"><div className="label">Fuel used (est.)</div><div className="value">{(stats.fuel_l ?? 0).toFixed(2)}<span className="unit">L</span></div></div>
          </div>
        </>
      )}

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
