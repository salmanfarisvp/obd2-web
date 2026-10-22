"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { LatLngTuple } from "leaflet";
import RequireAuth from "@/components/RequireAuth";
import RideChart from "@/components/RideChart";
import { supabase, Ride, Reading, FaultCode } from "@/lib/supabase";
import { formatDuration } from "@/lib/geo";
import { completeRide, fetchReadings } from "@/lib/rideSummary";

const RouteMap = dynamic(() => import("@/components/RouteMap"), { ssr: false });
const MAX_CHART_POINTS = 600;

function RideDetail({ id }: { id: string }) {
  const router = useRouter();
  const [ride, setRide] = useState<Ride | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [codes, setCodes] = useState<FaultCode[]>([]);
  const [error, setError] = useState<string | null>(null);

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
        setRide(await completeRide(data as Ride, rows));
        setCodes((dtc.data as FaultCode[]) ?? []);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [id]);

  const points = useMemo(
    () => readings.filter((r) => r.lat !== null && r.lon !== null).map((r) => [r.lat, r.lon] as LatLngTuple),
    [readings],
  );

  const chartData = useMemo(() => {
    if (!readings.length) return [];
    const t0 = new Date(readings[0].ts).getTime();
    const step = Math.max(1, Math.ceil(readings.length / MAX_CHART_POINTS));
    return readings
      .filter((_, i) => i % step === 0)
      .map((r) => ({
        min: (new Date(r.ts).getTime() - t0) / 60000,
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

  const economy = ride.fuel_l && ride.distance_km ? ride.distance_km / ride.fuel_l : null;

  return (
    <>
      <h1>{new Date(ride.started_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</h1>
      <p className="muted" style={{ marginTop: -10 }}>{ride.vehicle_name}</p>

      <div className="grid">
        <div className="card stat"><div className="label">Distance</div><div className="value">{(ride.distance_km ?? 0).toFixed(2)}<span className="unit">km</span></div></div>
        <div className="card stat"><div className="label">Duration</div><div className="value" style={{ fontSize: 20 }}>{formatDuration(ride.duration_s)}</div></div>
        <div className="card stat"><div className="label">Avg speed</div><div className="value">{Math.round(ride.avg_speed ?? 0)}<span className="unit">km/h</span></div></div>
        <div className="card stat"><div className="label">Max speed</div><div className="value">{Math.round(ride.max_speed ?? 0)}<span className="unit">km/h</span></div></div>
        {ride.max_rpm !== null && <div className="card stat"><div className="label">Max RPM</div><div className="value">{Math.round(ride.max_rpm)}</div></div>}
        {ride.max_coolant !== null && <div className="card stat"><div className="label">Coolant avg / max</div><div className="value">{avgCoolant?.toFixed(0) ?? "–"}/{Math.round(ride.max_coolant)}<span className="unit">°C</span></div></div>}
        {ride.fuel_l !== null && <div className="card stat"><div className="label">Fuel (est.)</div><div className="value">{ride.fuel_l.toFixed(2)}<span className="unit">L</span></div></div>}
        {economy !== null && <div className="card stat"><div className="label">Economy (est.)</div><div className="value">{economy.toFixed(1)}<span className="unit">km/L</span></div></div>}
      </div>

      {points.length > 1 && (
        <>
          <h2>Route</h2>
          <div className="map"><RouteMap points={points} /></div>
        </>
      )}

      {chartData.length > 1 && (
        <>
          <h2>Speed & RPM</h2>
          <div className="card">
            <RideChart
              data={chartData}
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
            <RideChart data={chartData} series={[
              { key: "coolant", name: "Coolant °C", color: "#ef4444" },
              { key: "intake_temp", name: "Intake air °C", color: "#22c55e" },
            ]} />
          </div>

          <h2>Throttle & load</h2>
          <div className="card">
            <RideChart data={chartData} series={[
              { key: "throttle", name: "Throttle %", color: "#a855f7" },
              { key: "load", name: "Engine load %", color: "#14b8a6" },
            ]} />
          </div>

          <h2>Battery</h2>
          <div className="card">
            <RideChart data={chartData} series={[{ key: "voltage", name: "Volts", color: "#eab308" }]} />
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
