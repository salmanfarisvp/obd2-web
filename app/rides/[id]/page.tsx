"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LatLngTuple } from "leaflet";
import RequireAuth from "@/components/RequireAuth";
import RideChart, { ChartRow } from "@/components/RideChart";
import RideReplay from "@/components/RideReplay";
import { SPEED_BANDS, TrackPoint } from "@/components/RouteMap";
import RideNote from "@/components/RideNote";
import { supabase, Ride, Reading, FaultCode } from "@/lib/supabase";
import { formatDuration } from "@/lib/geo";
import { completeRide, fetchReadings } from "@/lib/rideSummary";
import { calibration, DEFAULT_CURRENCY, FuelData, Mileage, loadFuelData, money, priceAt, realMileage, rideCost, rideFuel } from "@/lib/fuel";

const RouteMap = dynamic(() => import("@/components/RouteMap"), { ssr: false });
const MAX_CHART_POINTS = 400;

function RideDetail({ id }: { id: string }) {
  const router = useRouter();
  const [ride, setRide] = useState<Ride | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [codes, setCodes] = useState<FaultCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursorState] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fuel, setFuel] = useState<FuelData | null>(null);
  const [mileage, setMileage] = useState<Mileage | null>(null);
  const setCursor = useCallback((i: number) => setCursorState(i), []);
  // Charts move the cursor on hover/touch; stop any playback when the user takes over.
  const scrub = useCallback((i: number) => {
    setPlaying(false);
    setCursorState(i);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.from("rides").select("*").eq("id", id).single();
        if (error) throw error;
        setRide(data as Ride);
        const [rows, dtc] = await Promise.all([
          fetchReadings(id),
          supabase.from("fault_codes").select("*").eq("ride_id", id),
        ]);
        setReadings(rows);
        const finished = await completeRide(data as Ride, rows);
        setRide(finished);
        // Real mileage needs every ride of this vehicle, to line them up with the fuel log.
        const [fuelData, sameVehicle] = await Promise.all([
          loadFuelData(),
          supabase.from("rides").select("*").eq("vehicle_name", finished.vehicle_name),
        ]);
        setFuel(fuelData);
        setMileage(realMileage(finished.vehicle_name, (sameVehicle.data as Ride[]) ?? [], fuelData));
        setCodes((dtc.data as FaultCode[]) ?? []);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [id]);

  const track = useMemo<TrackPoint[]>(
    () =>
      readings.flatMap((r, i) =>
        r.lat !== null && r.lon !== null ? [{ i, lat: r.lat, lon: r.lon, speed: r.speed ?? r.gps_speed }] : [],
      ),
    [readings],
  );

  // Where the scooter was at each reading: the last GPS fix at or before it.
  const positions = useMemo(() => {
    let last: LatLngTuple | null = null;
    return readings.map((r) => (r.lat !== null && r.lon !== null ? (last = [r.lat, r.lon]) : last));
  }, [readings]);

  const t0 = readings.length ? Date.parse(readings[0].ts) : 0;
  const cursorMin = readings.length ? (Date.parse(readings[cursor].ts) - t0) / 60000 : undefined;

  const chartData = useMemo<ChartRow[]>(() => {
    if (!readings.length) return [];
    const start = Date.parse(readings[0].ts);
    const step = Math.max(1, Math.ceil(readings.length / MAX_CHART_POINTS));
    return readings
      .map((r, idx) => ({ r, idx }))
      .filter(({ idx }) => idx % step === 0)
      .map(({ r, idx }) => ({
        idx,
        min: (Date.parse(r.ts) - start) / 60000,
        speed: r.speed ?? r.gps_speed,
        rpm: r.rpm,
        coolant: r.coolant,
        intake_temp: r.intake_temp,
        throttle: r.throttle,
        load: r.load,
        voltage: r.voltage,
      }));
  }, [readings]);

  const hasObd = readings.some((r) => r.rpm !== null);
  const avgCoolant = useMemo(() => {
    const vals = readings.map((r) => r.coolant).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }, [readings]);

  async function remove() {
    if (!window.confirm("Delete this ride?")) return;
    await supabase.from("rides").delete().eq("id", id);
    router.replace("/rides");
  }

  if (error) return <p className="error">{error}</p>;
  if (!ride) return <p className="muted">Loading…</p>;

  const currency = fuel?.profile?.currency ?? DEFAULT_CURRENCY;
  const litres = rideFuel(ride, mileage);
  const cost = fuel ? rideCost(ride, mileage, fuel) : null;
  const price = fuel ? priceAt(fuel, ride.started_at) : null;
  const fuelLabel = calibration(mileage) ? "calibrated" : ride.fuel_l !== null ? "est." : "from mileage";

  return (
    <>
      <h1>{new Date(ride.started_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</h1>
      <p className="muted" style={{ marginTop: -10 }}>
        {ride.vehicle_name}
        {ride.ended_at && ` · ${new Date(ride.started_at).toLocaleTimeString(undefined, { timeStyle: "short" })}–${new Date(ride.ended_at).toLocaleTimeString(undefined, { timeStyle: "short" })}`}
      </p>
      {fuel && litres !== null && price === null && (
        <p className="muted">Set your petrol price in <Link href="/profile" style={{ color: "var(--accent)" }}>Profile</Link> to see this ride&apos;s cost.</p>
      )}
      <div className="card" style={{ marginBottom: 12 }}>
        <RideNote key={ride.id} rideId={ride.id} initial={ride.note} />
      </div>

      <div className="grid">
        <div className="card stat"><div className="label">Distance</div><div className="value">{(ride.distance_km ?? 0).toFixed(2)}<span className="unit">km</span></div></div>
        <div className="card stat"><div className="label">Duration</div><div className="value" style={{ fontSize: 20 }}>{formatDuration(ride.duration_s)}</div></div>
        {ride.moving_s !== null && <div className="card stat"><div className="label">Riding time</div><div className="value" style={{ fontSize: 20 }}>{formatDuration(ride.moving_s)}</div></div>}
        {ride.idle_s !== null && <div className="card stat"><div className="label">Idle time</div><div className="value" style={{ fontSize: 20 }}>{formatDuration(ride.idle_s)}</div></div>}
        {ride.stops !== null && <div className="card stat"><div className="label">Stops</div><div className="value">{ride.stops}</div></div>}
        <div className="card stat"><div className="label">Avg speed</div><div className="value">{Math.round(ride.avg_speed ?? 0)}<span className="unit">km/h</span></div></div>
        {ride.moving_s ? <div className="card stat"><div className="label">Riding avg</div><div className="value">{Math.round((ride.distance_km ?? 0) / (ride.moving_s / 3600))}<span className="unit">km/h</span></div></div> : null}
        <div className="card stat"><div className="label">Max speed</div><div className="value">{Math.round(ride.max_speed ?? 0)}<span className="unit">km/h</span></div></div>
        {ride.max_rpm !== null && <div className="card stat"><div className="label">Max RPM</div><div className="value">{Math.round(ride.max_rpm)}</div></div>}
        {ride.max_coolant !== null && <div className="card stat"><div className="label">Coolant avg / max</div><div className="value">{avgCoolant?.toFixed(0) ?? "–"}/{Math.round(ride.max_coolant)}<span className="unit">°C</span></div></div>}
        {litres !== null && <div className="card stat"><div className="label">Fuel ({fuelLabel})</div><div className="value">{litres.toFixed(2)}<span className="unit">L</span></div></div>}
        {litres && ride.distance_km ? <div className="card stat"><div className="label">Mileage</div><div className="value">{(ride.distance_km / litres).toFixed(1)}<span className="unit">km/L</span></div></div> : null}
        {cost !== null && <div className="card stat"><div className="label">Cost</div><div className="value">{money(currency, cost)}</div></div>}
        {cost !== null && ride.distance_km ? <div className="card stat"><div className="label">Cost / km</div><div className="value">{money(currency, cost / ride.distance_km)}</div></div> : null}
      </div>

      {(track.length > 1 || readings.length > 1) && <h2>Replay</h2>}
      {track.length > 1 && (
        <>
          <div className="map"><RouteMap track={track} marker={positions[cursor] ?? null} onPick={scrub} /></div>
          <div className="legend">
            <span>Speed km/h:</span>
            {SPEED_BANDS.map((b) => <span key={b.label}><i style={{ background: b.color }} />{b.label}</span>)}
          </div>
        </>
      )}
      {readings.length > 1 && (
        <RideReplay readings={readings} cursor={cursor} setCursor={setCursor} playing={playing} setPlaying={setPlaying} />
      )}

      {chartData.length > 1 && (
        <>
          <h2>Speed & RPM</h2>
          <div className="card">
            <RideChart
              data={chartData}
              cursorMin={cursorMin}
              onScrub={scrub}
              series={[
                { key: "speed", name: "Speed km/h", color: "#3b82f6" },
                ...(hasObd ? [{ key: "rpm", name: "RPM", color: "#f59e0b", axis: "right" as const }] : []),
              ]}
            />
          </div>
        </>
      )}

      {hasObd && (
        <>
          <h2>Temperatures</h2>
          <div className="card">
            <RideChart data={chartData} cursorMin={cursorMin} onScrub={scrub} series={[
              { key: "coolant", name: "Coolant °C", color: "#ef4444" },
              { key: "intake_temp", name: "Intake air °C", color: "#22c55e" },
            ]} />
          </div>

          <h2>Throttle & load</h2>
          <div className="card">
            <RideChart data={chartData} cursorMin={cursorMin} onScrub={scrub} series={[
              { key: "throttle", name: "Throttle %", color: "#a855f7" },
              { key: "load", name: "Engine load %", color: "#14b8a6" },
            ]} />
          </div>

          <h2>Battery</h2>
          <div className="card">
            <RideChart data={chartData} cursorMin={cursorMin} onScrub={scrub} series={[{ key: "voltage", name: "Volts", color: "#eab308" }]} />
          </div>
        </>
      )}

      <h2>Fault codes</h2>
      <div className="card">
        {codes.length
          ? codes.map((c) => <span key={c.id} className="pill bad" style={{ marginRight: 6 }}>{c.code}</span>)
          : <span className="pill ok">None recorded</span>}
      </div>

      <div style={{ marginTop: 24 }}>
        <button className="danger" onClick={remove}>Delete ride</button>
      </div>
    </>
  );
}

export default function RidePage({ params }: { params: { id: string } }) {
  return (
    <RequireAuth>
      <RideDetail id={params.id} />
    </RequireAuth>
  );
}
