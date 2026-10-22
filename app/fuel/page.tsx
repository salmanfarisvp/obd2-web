"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import RequireAuth from "@/components/RequireAuth";
import { useRecorder } from "@/components/RecorderProvider";
import { DEFAULT_CURRENCY, FuelData, loadFuelData, money, realMileage } from "@/lib/fuel";
import { supabase, Ride } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";

/** Value for a datetime-local input, in local time. */
function localInput(d: Date) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

function FuelLogPage() {
  const { vehicle: currentVehicle } = useRecorder();
  const session = useSession();
  const [data, setData] = useState<FuelData | null>(null);
  const [rides, setRides] = useState<Ride[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [vehicle, setVehicle] = useState(currentVehicle);
  const [when, setWhen] = useState(localInput(new Date()));
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [litres, setLitres] = useState("");
  const [fullTank, setFullTank] = useState(false);
  const [note, setNote] = useState("");
  const [source, setSource] = useState<"manual" | "auto">("manual");
  const [saving, setSaving] = useState(false);

  async function reload() {
    const [fuel, r] = await Promise.all([loadFuelData(), supabase.from("rides").select("*")]);
    setData(fuel);
    setRides((r.data as Ride[]) ?? []);
    return fuel;
  }

  useEffect(() => {
    reload().then((fuel) => {
      const last = [...fuel.logs].reverse().find((l) => l.price_per_l);
      setPrice((last?.price_per_l ?? fuel.profile?.fuel_price)?.toString() ?? "");
      // Prefill from the Ride page's "looks like you filled up" prompt.
      const q = new URLSearchParams(window.location.search);
      if (q.get("litres")) {
        setLitres(q.get("litres")!);
        if (q.get("vehicle")) setVehicle(q.get("vehicle")!);
        if (q.get("at")) setWhen(localInput(new Date(q.get("at")!)));
        setSource("auto");
      }
    }, (e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Typing the amount fills in litres and vice versa, using the price.
  const p = Number(price);
  function onAmount(v: string) {
    setAmount(v);
    if (p > 0 && Number(v) > 0) setLitres((Number(v) / p).toFixed(2));
  }
  function onLitres(v: string) {
    setLitres(v);
    if (p > 0 && Number(v) > 0) setAmount((Number(v) * p).toFixed(2));
  }
  function onPrice(v: string) {
    setPrice(v);
    if (Number(v) > 0 && Number(litres) > 0) setAmount((Number(litres) * Number(v)).toFixed(2));
  }

  async function add() {
    const l = Number(litres);
    if (!(l > 0)) return setError("Enter the litres or the amount paid.");
    setError(null);
    setSaving(true);
    const filledAt = new Date(when).toISOString();
    const { error } = await supabase.from("fuel_logs").insert({
      vehicle_name: vehicle.trim() || currentVehicle,
      filled_at: filledAt,
      litres: l,
      amount: Number(amount) > 0 ? Number(amount) : null,
      price_per_l: p > 0 ? p : null,
      full_tank: fullTank,
      source,
      note: note.trim() || null,
    });
    // The newest fill-up's price becomes the current petrol price.
    const isNewest = !data!.logs.some((x) => x.filled_at > filledAt);
    if (!error && p > 0 && isNewest) {
      await supabase
        .from("profiles")
        .upsert({ user_id: session!.user.id, fuel_price: p, currency: data!.profile?.currency ?? DEFAULT_CURRENCY });
    }
    setSaving(false);
    if (error) return setError(error.message);
    setAmount("");
    setLitres("");
    setFullTank(false);
    setNote("");
    setSource("manual");
    setWhen(localInput(new Date()));
    window.history.replaceState(null, "", "/fuel");
    reload();
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this fill-up?")) return;
    await supabase.from("fuel_logs").delete().eq("id", id);
    reload();
  }

  const names = useMemo(
    () => Array.from(new Set([currentVehicle, ...(data?.vehicles.map((v) => v.name) ?? []), ...rides.map((r) => r.vehicle_name)])),
    [currentVehicle, data, rides],
  );

  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const currency = data.profile?.currency ?? DEFAULT_CURRENCY;
  const logs = [...data.logs].reverse();

  return (
    <>
      <h1>Fuel</h1>

      <div className="list">
        {names.map((n) => {
          const m = realMileage(n, rides, data);
          const vLogs = data.logs.filter((l) => l.vehicle_name === n);
          if (!vLogs.length && n !== vehicle) return null;
          const spent = vLogs.reduce((s, l) => s + (l.amount ?? 0), 0);
          return (
            <div key={n} className="card">
              <div style={{ fontWeight: 700, marginBottom: 8 }}>{n}</div>
              <div className="grid">
                <div className="stat"><div className="label">Real mileage</div><div className="value">{m ? m.kmPerL.toFixed(1) : "–"}<span className="unit">km/L</span></div></div>
                <div className="stat"><div className="label">Fill-ups</div><div className="value">{vLogs.length}</div></div>
                <div className="stat"><div className="label">Petrol bought</div><div className="value">{vLogs.reduce((s, l) => s + l.litres, 0).toFixed(1)}<span className="unit">L</span></div></div>
                <div className="stat"><div className="label">Spent</div><div className="value">{spent > 0 ? money(currency, spent) : "–"}</div></div>
              </div>
              <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
                {m
                  ? `${m.km.toFixed(0)} km on ${m.litres.toFixed(1)} L between fill-ups` +
                    (m.confident ? "." : ". Approximate: it gets more accurate with every fill-up.")
                  : "Real mileage appears after two fill-ups with rides logged between them."}
              </p>
            </div>
          );
        })}
      </div>

      <h2>Add fill-up</h2>
      <div className="card">
        {source === "auto" && <p className="pill ok" style={{ marginTop: 0 }}>Detected from the fuel gauge — check and save</p>}
        <label style={{ marginTop: 0 }}>Vehicle</label>
        <select className="select" value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <label>Date and time</label>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <label>Price per litre ({currency.trim()})</label>
        <input inputMode="decimal" placeholder="e.g. 102.50" value={price} onChange={(e) => onPrice(e.target.value)} />
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 120 }}>
            <label>Amount paid ({currency.trim()})</label>
            <input inputMode="decimal" placeholder="e.g. 200" value={amount} onChange={(e) => onAmount(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 120 }}>
            <label>Litres</label>
            <input inputMode="decimal" placeholder="e.g. 1.95" value={litres} onChange={(e) => onLitres(e.target.value)} />
          </div>
        </div>
        <label className="row" style={{ color: "var(--text)", fontSize: 15 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={fullTank} onChange={(e) => setFullTank(e.target.checked)} />
          Filled to full tank
        </label>
        <label>Note</label>
        <input placeholder="Optional, e.g. HP pump near office" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={add} disabled={saving}>{saving ? "Saving…" : "Add fill-up"}</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      <h2>Fill-ups</h2>
      {!logs.length && <p className="muted">No fill-ups yet.</p>}
      <div className="list">
        {logs.map((l) => (
          <div key={l.id} className="card ride-item">
            <div>
              <div style={{ fontWeight: 600 }}>
                {new Date(l.filled_at).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {l.vehicle_name}
                {l.price_per_l && ` · ${money(currency, l.price_per_l)}/L`}
                {l.full_tank && " · full tank"}
                {l.source === "auto" && " · detected"}
              </div>
              {l.note && <div style={{ fontSize: 13, marginTop: 2 }}>📝 {l.note}</div>}
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontWeight: 700 }}>{l.litres.toFixed(2)} L</div>
              <div className="muted" style={{ fontSize: 13 }}>{l.amount ? money(currency, l.amount) : ""}</div>
              <button style={{ marginTop: 6, padding: "6px 10px" }} onClick={() => remove(l.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Tip: set your tank size in <Link href="/profile" style={{ color: "var(--accent)" }}>Profile</Link>. It&apos;s used to judge how accurate
        partial-fill mileage is.
      </p>
    </>
  );
}

export default function FuelPage() {
  return (
    <RequireAuth>
      <FuelLogPage />
    </RequireAuth>
  );
}
