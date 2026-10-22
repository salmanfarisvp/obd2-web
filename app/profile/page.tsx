"use client";
import { useEffect, useState } from "react";
import RequireAuth from "@/components/RequireAuth";
import { useRecorder } from "@/components/RecorderProvider";
import { DEFAULT_CURRENCY, loadFuelData } from "@/lib/fuel";
import { supabase, Vehicle } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";

const CURRENCIES = ["₹", "$", "€", "£", "AED ", "SAR "];
type VehicleDraft = { id?: string; name: string; originalName?: string; tank: string };

function ProfileForm() {
  const session = useSession();
  const { vehicle: currentVehicle, setVehicle: setCurrentVehicle } = useRecorder();
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [price, setPrice] = useState("");
  const [vehicles, setVehicles] = useState<VehicleDraft[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const data = await loadFuelData();
      if (data.profile) {
        setCurrency(data.profile.currency);
        setPrice(data.profile.fuel_price?.toString() ?? "");
      }
      if (data.vehicles.length) {
        setVehicles(data.vehicles.map((v) => ({ id: v.id, name: v.name, originalName: v.name, tank: v.tank_l?.toString() ?? "" })));
      } else {
        // Suggest the vehicles already used for rides.
        const { data: rides } = await supabase.from("rides").select("vehicle_name");
        const names = Array.from(new Set([currentVehicle, ...((rides ?? []) as { vehicle_name: string }[]).map((r) => r.vehicle_name)]));
        setVehicles(names.map((name) => ({ name, tank: name === "Suzuki Access 125" ? "5.3" : "" })));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateVehicle(i: number, patch: Partial<VehicleDraft>) {
    setVehicles((vs) => vs!.map((v, k) => (k === i ? { ...v, ...patch } : v)));
    setStatus(null);
  }

  async function save() {
    setStatus("Saving…");
    const parsedPrice = price.trim() ? Number(price) : null;
    if (parsedPrice !== null && !(parsedPrice > 0)) return setStatus("Enter a valid petrol price.");
    const { error } = await supabase.from("profiles").upsert({ user_id: session!.user.id, currency, fuel_price: parsedPrice });
    if (error) return setStatus(`Couldn't save: ${error.message}`);

    const saved: VehicleDraft[] = [];
    for (const v of vehicles!) {
      const name = v.name.trim();
      if (!name) continue;
      const row = { ...(v.id && { id: v.id }), name, tank_l: v.tank.trim() ? Number(v.tank) : null };
      const { data, error } = await supabase.from("vehicles").upsert(row).select().single();
      if (error) return setStatus(`Couldn't save ${name}: ${error.message}`);
      // Rides and fill-ups refer to the vehicle by name, so a rename carries over to them.
      if (v.originalName && v.originalName !== name) {
        await supabase.from("rides").update({ vehicle_name: name }).eq("vehicle_name", v.originalName);
        await supabase.from("fuel_logs").update({ vehicle_name: name }).eq("vehicle_name", v.originalName);
        if (currentVehicle === v.originalName) setCurrentVehicle(name);
      }
      const saved_ = data as Vehicle;
      saved.push({ id: saved_.id, name: saved_.name, originalName: saved_.name, tank: saved_.tank_l?.toString() ?? "" });
    }
    setVehicles(saved);
    setStatus("Saved");
  }

  async function removeVehicle(i: number) {
    const v = vehicles![i];
    if (v.id) {
      if (!window.confirm(`Remove ${v.name}? Its rides and fill-ups are kept.`)) return;
      await supabase.from("vehicles").delete().eq("id", v.id);
    }
    setVehicles((vs) => vs!.filter((_, k) => k !== i));
  }

  if (!vehicles) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Profile</h1>
      <div className="card">
        <label>Currency</label>
        <div className="row">
          {CURRENCIES.map((c) => (
            <button key={c} className={currency === c ? "primary" : ""} onClick={() => { setCurrency(c); setStatus(null); }}>
              {c.trim()}
            </button>
          ))}
          <input style={{ width: 90 }} value={currency} onChange={(e) => { setCurrency(e.target.value); setStatus(null); }} aria-label="Custom currency symbol" maxLength={5} />
        </div>
        <label>Petrol price per litre ({currency.trim()})</label>
        <input inputMode="decimal" placeholder="e.g. 102.50" value={price} onChange={(e) => { setPrice(e.target.value); setStatus(null); }} />
        <p className="muted" style={{ fontSize: 13 }}>Used for ride costs until you log a fill-up; each fill-up then sets the price.</p>
      </div>

      <h2>Vehicles</h2>
      <div className="list">
        {vehicles.map((v, i) => (
          <div key={v.id ?? `new-${i}`} className="card">
            <label style={{ marginTop: 0 }}>Name</label>
            <input value={v.name} onChange={(e) => updateVehicle(i, { name: e.target.value })} />
            <label>Tank capacity (L)</label>
            <input inputMode="decimal" placeholder="e.g. 5.3" value={v.tank} onChange={(e) => updateVehicle(i, { tank: e.target.value })} />
            <div className="row" style={{ marginTop: 12 }}>
              <button onClick={() => removeVehicle(i)}>Remove</button>
            </div>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={() => setVehicles((vs) => [...vs!, { name: "", tank: "" }])}>+ Add vehicle</button>
      </div>

      <div className="row" style={{ marginTop: 24 }}>
        <button className="primary" onClick={save}>Save profile</button>
        {status && <span className="muted">{status}</span>}
      </div>

      <h2>Account</h2>
      <div className="card row" style={{ justifyContent: "space-between" }}>
        <span className="muted">{session?.user.email}</span>
        <button onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </>
  );
}

export default function ProfilePage() {
  return (
    <RequireAuth>
      <ProfileForm />
    </RequireAuth>
  );
}
