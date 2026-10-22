"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Reading } from "@/lib/supabase";

const RATES = [10, 30, 60];
const TICK_MS = 100;

/** Time slider, play button and the readings at the selected moment. */
export default function RideReplay({
  readings,
  cursor,
  setCursor,
  playing,
  setPlaying,
}: {
  readings: Reading[];
  cursor: number;
  setCursor: (i: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
}) {
  const [rate, setRate] = useState(RATES[1]);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const parsed = useMemo(() => readings.map((r) => Date.parse(r.ts)), [readings]);
  const times = useRef(parsed);
  times.current = parsed;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const t = times.current;
      let i = cursorRef.current;
      const target = t[i] + TICK_MS * rate;
      while (i < t.length - 1 && t[i + 1] <= target) i++;
      if (i === cursorRef.current) i = Math.min(i + 1, t.length - 1);
      setCursor(i);
      if (i >= t.length - 1) setPlaying(false);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, rate, setCursor, setPlaying]);

  const r = readings[cursor];
  const t0 = times.current[0];
  const elapsedS = (times.current[cursor] - t0) / 1000;
  const fmt = (v: number | null, d = 0) => (v === null ? "–" : v.toFixed(d));
  const speed = r.speed ?? r.gps_speed;

  function togglePlay() {
    if (!playing && cursor >= readings.length - 1) setCursor(0);
    setPlaying(!playing);
  }

  const cells: [string, string, string][] = [
    ["Speed", fmt(speed), "km/h"],
    ["RPM", fmt(r.rpm), ""],
    ["Throttle", fmt(r.throttle), "%"],
    ["Load", fmt(r.load), "%"],
    ["Coolant", fmt(r.coolant), "°C"],
    ["Intake air", fmt(r.intake_temp), "°C"],
    ["Battery", fmt(r.voltage, 1), "V"],
    ["Fuel rate", fmt(r.fuel_rate, 2), "L/h"],
  ];

  return (
    <div className="card replay">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <b>{new Date(r.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</b>
          <span className="muted"> · {Math.floor(elapsedS / 60)}:{String(Math.floor(elapsedS % 60)).padStart(2, "0")} in</span>
          {r.lat === null && <span className="pill warn" style={{ marginLeft: 6 }}>no GPS</span>}
        </div>
        <div className="row">
          <button onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>{playing ? "❚❚" : "▶"}</button>
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Playback speed">
            {RATES.map((x) => <option key={x} value={x}>{x}×</option>)}
          </select>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={readings.length - 1}
        value={cursor}
        onChange={(e) => {
          setPlaying(false);
          setCursor(Number(e.target.value));
        }}
        aria-label="Ride time"
      />
      <div className="replay-grid">
        {cells.map(([label, value, unit]) => (
          <div key={label} className="stat">
            <div className="label">{label}</div>
            <div className="value" style={{ fontSize: 20 }}>{value}<span className="unit">{unit}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}
