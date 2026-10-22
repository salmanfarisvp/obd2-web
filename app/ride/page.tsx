"use client";
import Link from "next/link";
import RequireAuth from "@/components/RequireAuth";
import { useRecorder } from "@/components/RecorderProvider";
import { formatDuration } from "@/lib/geo";

function RideRecorder() {
  const { adapter, connecting, error, vehicle, setVehicle, rideId, live, fix, stats, dtcs, unsent, phase, connect, start, stop } =
    useRecorder();

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
