"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import RequireAuth from "@/components/RequireAuth";
import { supabase, Ride } from "@/lib/supabase";
import { formatDuration } from "@/lib/geo";

function RideList() {
  const [rides, setRides] = useState<Ride[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("rides")
      .select("*")
      .order("started_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setRides(data as Ride[]);
      });
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!rides) return <p className="muted">Loading…</p>;

  const totalKm = rides.reduce((sum, r) => sum + (r.distance_km ?? 0), 0);
  const totalS = rides.reduce((sum, r) => sum + (r.duration_s ?? 0), 0);

  return (
    <>
      <h1>Ride history</h1>
      <div className="grid">
        <div className="card stat"><div className="label">Rides</div><div className="value">{rides.length}</div></div>
        <div className="card stat"><div className="label">Total distance</div><div className="value">{totalKm.toFixed(1)}<span className="unit">km</span></div></div>
        <div className="card stat"><div className="label">Time riding</div><div className="value" style={{ fontSize: 20 }}>{formatDuration(totalS)}</div></div>
      </div>

      <h2>Rides</h2>
      {rides.length === 0 && <p className="muted">No rides yet. <Link href="/ride" style={{ color: "var(--accent)" }}>Start one →</Link></p>}
      <div className="list">
        {rides.map((r) => (
          <Link key={r.id} href={`/rides/${r.id}`} className="card ride-item">
            <div>
              <div style={{ fontWeight: 600 }}>
                {new Date(r.started_at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {r.vehicle_name} · {formatDuration(r.duration_s)}
                {r.ended_at === null && " · not finished"}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontWeight: 700 }}>{(r.distance_km ?? 0).toFixed(1)} km</div>
              <div className="muted" style={{ fontSize: 13 }}>max {Math.round(r.max_speed ?? 0)} km/h</div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

export default function RidesPage() {
  return (
    <RequireAuth>
      <RideList />
    </RequireAuth>
  );
}
