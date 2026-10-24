"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import RequireAuth from "@/components/RequireAuth";
import { supabase, Ride } from "@/lib/supabase";
import { formatDuration } from "@/lib/geo";
import { completeRide } from "@/lib/rideSummary";
import { mergeRides } from "@/lib/merge";
import { DEFAULT_CURRENCY, FuelData, Mileage, loadFuelData, money, realMileage, rideCost, rideFuel } from "@/lib/fuel";

function VehicleCard({ name, rides, mileage, data }: { name: string; rides: Ride[]; mileage: Mileage | null; data: FuelData }) {
  const currency = data.profile?.currency ?? DEFAULT_CURRENCY;
  const km = rides.reduce((s, r) => s + (r.distance_km ?? 0), 0);
  const fuel = rides.reduce((s, r) => s + (rideFuel(r, mileage) ?? 0), 0);
  const costs = rides.map((r) => rideCost(r, mileage, data));
  const cost = costs.reduce<number>((s, c) => s + (c ?? 0), 0);
  // Only rides with a known fuel figure count towards km/L and cost per km.
  const fuelledKm = rides.reduce((s, r) => s + (rideFuel(r, mileage) !== null ? r.distance_km ?? 0 : 0), 0);
  const costedKm = rides.reduce((s, r, i) => s + (costs[i] !== null ? r.distance_km ?? 0 : 0), 0);

  return (
    <div className="card">
      <div style={{ fontWeight: 700, marginBottom: 8 }}>{name}</div>
      <div className="grid">
        <div className="stat"><div className="label">Distance</div><div className="value">{km.toFixed(1)}<span className="unit">km</span></div></div>
        <div className="stat"><div className="label">Rides</div><div className="value">{rides.length}</div></div>
        <div className="stat">
          <div className="label">Mileage {mileage ? "(real)" : "(est.)"}</div>
          <div className="value">
            {mileage ? mileage.kmPerL.toFixed(1) : fuel > 0 ? (fuelledKm / fuel).toFixed(1) : "–"}
            <span className="unit">km/L</span>
          </div>
        </div>
        <div className="stat"><div className="label">Fuel used</div><div className="value">{fuel.toFixed(2)}<span className="unit">L</span></div></div>
        <div className="stat"><div className="label">Fuel cost</div><div className="value">{cost > 0 ? money(currency, cost) : "–"}</div></div>
        <div className="stat"><div className="label">Cost / km</div><div className="value">{costedKm > 0 ? money(currency, cost / costedKm) : "–"}</div></div>
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
        {mileage
          ? `Real mileage from ${mileage.fills} fill-ups (${mileage.litres.toFixed(1)} L, ${mileage.km.toFixed(0)} km)` +
            (mileage.confident ? "." : ". Approximate until you've logged a few more fill-ups.")
          : "Estimated from engine data. "}
        {!mileage && <Link href="/fuel" style={{ color: "var(--accent)" }}>Log fill-ups</Link>}
        {!mileage && " for real mileage."}
        {!data.profile?.fuel_price && !data.logs.length && (
          <> Set your petrol price in <Link href="/profile" style={{ color: "var(--accent)" }}>Profile</Link> to see costs.</>
        )}
      </p>
    </div>
  );
}

function RideList() {
  const [rides, setRides] = useState<Ride[] | null>(null);
  const [fuel, setFuel] = useState<FuelData>({ profile: null, vehicles: [], logs: [] });
  const [vehicle, setVehicle] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function merge() {
    const picked = rides!.filter((r) => selected.has(r.id));
    if (!window.confirm(`Merge ${picked.length} rides into one? The time between them becomes breaks.`)) return;
    setMerging(true);
    try {
      const merged = await mergeRides(picked);
      setRides((all) => all!.filter((r) => !selected.has(r.id) || r.id === merged.id).map((r) => (r.id === merged.id ? merged : r)));
      setSelected(new Set());
      setSelecting(false);
    } catch (e) {
      setError((e as Error).message);
    }
    setMerging(false);
  }

  useEffect(() => {
    loadFuelData().then(setFuel, () => {});
    (async () => {
      const { data, error } = await supabase.from("rides").select("*").order("started_at", { ascending: false });
      if (error) return setError(error.message);
      setRides(data as Ride[]);
      // Rides that were never stopped have no totals yet; work them out from their readings.
      if ((data as Ride[]).some((r) => r.ended_at === null || r.moving_s === null || r.breaks === null)) {
        setRides(await Promise.all((data as Ride[]).map((r) => completeRide(r).catch(() => r))));
      }
    })();
  }, []);

  const names = useMemo(() => Array.from(new Set((rides ?? []).map((r) => r.vehicle_name))), [rides]);
  const mileages = useMemo(
    () => Object.fromEntries(names.map((n) => [n, realMileage(n, rides ?? [], fuel)])),
    [names, rides, fuel],
  );

  if (error) return <p className="error">{error}</p>;
  if (!rides) return <p className="muted">Loading…</p>;

  const shown = vehicle === "all" ? rides : rides.filter((r) => r.vehicle_name === vehicle);
  const currency = fuel.profile?.currency ?? DEFAULT_CURRENCY;
  const totalKm = shown.reduce((sum, r) => sum + (r.distance_km ?? 0), 0);
  const totalS = shown.reduce((sum, r) => sum + (r.duration_s ?? 0), 0);
  const movingS = shown.reduce((sum, r) => sum + (r.moving_s ?? 0), 0);
  const idleS = shown.reduce((sum, r) => sum + (r.idle_s ?? 0), 0);
  const picked = rides.filter((r) => selected.has(r.id));
  const canMerge = picked.length >= 2 && new Set(picked.map((r) => r.vehicle_name)).size === 1;

  return (
    <>
      <h1>Ride history</h1>
      {names.length > 1 && (
        <div className="row" style={{ marginBottom: 12 }}>
          {["all", ...names].map((n) => (
            <button key={n} className={vehicle === n ? "primary" : ""} onClick={() => setVehicle(n)}>
              {n === "all" ? "All vehicles" : n}
            </button>
          ))}
        </div>
      )}
      <div className="grid">
        <div className="card stat"><div className="label">Rides</div><div className="value">{shown.length}</div></div>
        <div className="card stat"><div className="label">Total distance</div><div className="value">{totalKm.toFixed(1)}<span className="unit">km</span></div></div>
        <div className="card stat"><div className="label">Total time</div><div className="value" style={{ fontSize: 20 }}>{formatDuration(totalS)}</div></div>
        <div className="card stat"><div className="label">Riding time</div><div className="value" style={{ fontSize: 20 }}>{formatDuration(movingS)}</div></div>
        <div className="card stat"><div className="label">Idle time</div><div className="value" style={{ fontSize: 20 }}>{formatDuration(idleS)}</div></div>
      </div>

      <h2>Mileage & cost</h2>
      <div className="list">
        {names
          .filter((n) => vehicle === "all" || n === vehicle)
          .map((n) => (
            <VehicleCard key={n} name={n} rides={rides.filter((r) => r.vehicle_name === n)} mileage={mileages[n]} data={fuel} />
          ))}
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 24 }}>
        <h2 style={{ margin: 0 }}>Rides</h2>
        {shown.length > 1 && (
          <div className="row">
            {selecting && (
              <button className="primary" onClick={merge} disabled={merging || !canMerge}>
                {merging ? "Merging…" : `Merge ${selected.size || ""}`}
              </button>
            )}
            <button onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>{selecting ? "Cancel" : "Select"}</button>
          </div>
        )}
      </div>
      {selecting && (
        <p className="muted" style={{ fontSize: 13 }}>
          Pick two or more rides on the same vehicle to merge them into one; the time between them becomes breaks.
        </p>
      )}
      {rides.length === 0 && <p className="muted">No rides yet. <Link href="/ride" style={{ color: "var(--accent)" }}>Start one →</Link></p>}
      <div className="list">
        {shown.map((r) => {
          const cost = rideCost(r, mileages[r.vehicle_name], fuel);
          const body = (
            <>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {new Date(r.started_at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {r.ended_at && `–${new Date(r.ended_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
                </div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {r.vehicle_name} · {formatDuration(r.duration_s)}
                  {r.breaks ? ` · ☕ ${r.breaks} break${r.breaks > 1 ? "s" : ""}` : ""}
                  {r.ended_at === null && " · in progress"}
                </div>
                {r.note && <div style={{ fontSize: 13, marginTop: 2 }}>📝 {r.note}</div>}
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontWeight: 700 }}>{(r.distance_km ?? 0).toFixed(1)} km</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {cost !== null ? money(currency, cost) : `max ${Math.round(r.max_speed ?? 0)} km/h`}
                </div>
              </div>
            </>
          );
          return selecting ? (
            <label key={r.id} className="card ride-item" style={{ cursor: "pointer", borderColor: selected.has(r.id) ? "var(--accent)" : undefined }}>
              <input type="checkbox" style={{ width: "auto" }} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
              {body}
            </label>
          ) : (
            <Link key={r.id} href={`/rides/${r.id}`} className="card ride-item">{body}</Link>
          );
        })}
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
