"use client";
import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/geo";
import { CardFormat, CardStat, renderShareCard, rideTitle } from "@/lib/shareCard";
import type { Reading, Ride } from "@/lib/supabase";

type Props = {
  ride: Ride;
  readings: Reading[];
  fuelL: number | null;
  cost: string | null;
};

export default function ShareRide({ ride, readings, fuelL, cost }: Props) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<CardFormat>("square");
  const [hideEnds, setHideEnds] = useState(true);
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    const km = ride.distance_km ?? 0;
    const ridingS = ride.moving_s || ride.duration_s || 0;
    const coolant = readings.map((r) => r.coolant).filter((v): v is number => v !== null);
    const main: CardStat[] = [
      { label: "Distance", value: km.toFixed(km < 10 ? 2 : 1), unit: "km" },
      { label: "Riding time", value: formatDuration(ridingS) },
      { label: "Avg speed", value: ridingS ? Math.round(km / (ridingS / 3600)).toString() : "–", unit: "km/h" },
      { label: "Top speed", value: Math.round(ride.max_speed ?? 0).toString(), unit: "km/h" },
    ];
    const engine: CardStat[] = [
      ...(ride.max_rpm ? [{ label: "Max RPM", value: Math.round(ride.max_rpm).toString() }] : []),
      ...(coolant.length ? [{ label: "Coolant", value: Math.round(Math.max(...coolant)).toString(), unit: "°C" }] : []),
      ...(fuelL ? [{ label: "Fuel", value: fuelL.toFixed(2), unit: "L" }] : []),
      ...(fuelL && km ? [{ label: "Mileage", value: (km / fuelL).toFixed(1), unit: "km/L" }] : []),
      ...(cost ? [{ label: "Cost", value: cost }] : []),
      ...(ride.idle_s ? [{ label: "Idle", value: formatDuration(ride.idle_s) }] : []),
    ];
    const date = new Date(ride.started_at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    renderShareCard({
      readings,
      title: rideTitle(ride.started_at, ride.note),
      subtitle: `${date} · ${ride.vehicle_name}`,
      main,
      engine,
      format,
      hideEnds,
    }).then((blob) => {
      if (cancelled) return;
      setImage((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { blob, url: URL.createObjectURL(blob) };
      });
      setBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, format, hideEnds, ride, readings, fuelL, cost]);

  const fileName = `ride-${ride.started_at.slice(0, 10)}.png`;

  async function share() {
    if (!image) return;
    const file = new File([image.blob], fileName, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "My ride" });
      } catch {
        // Cancelled.
      }
    } else {
      download();
    }
  }

  function download() {
    if (!image) return;
    const a = document.createElement("a");
    a.href = image.url;
    a.download = fileName;
    a.click();
  }

  if (!open) {
    return <button className="primary" onClick={() => setOpen(true)}>📤 Share ride</button>;
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          {(["square", "story"] as const).map((f) => (
            <button key={f} className={format === f ? "primary" : ""} onClick={() => setFormat(f)}>
              {f === "square" ? "Square" : "Story"}
            </button>
          ))}
        </div>
        <button onClick={() => setOpen(false)}>Close</button>
      </div>
      <label className="row" style={{ color: "var(--text)", fontSize: 15 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={hideEnds} onChange={(e) => setHideEnds(e.target.checked)} />
        Hide where the ride starts and ends
      </label>
      <div style={{ marginTop: 12, textAlign: "center", opacity: busy ? 0.5 : 1 }}>
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.url} alt="Ride share card" style={{ maxWidth: "100%", maxHeight: 520, borderRadius: 12 }} />
        ) : (
          <p className="muted">Creating card…</p>
        )}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={share} disabled={!image || busy}>Share</button>
        <button onClick={download} disabled={!image || busy}>Download</button>
      </div>
    </div>
  );
}
