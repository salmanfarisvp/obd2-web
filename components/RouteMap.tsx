"use client";
import "leaflet/dist/leaflet.css";
import { useMemo } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import { divIcon, type LatLngTuple } from "leaflet";

export type TrackPoint = { i: number; lat: number; lon: number; speed: number | null };
export type BreakPin = { lat: number; lon: number; seconds: number };

const breakIcon = divIcon({ html: "☕", className: "break-pin", iconSize: [24, 24], iconAnchor: [12, 12] });

// Slow → fast, green → red.
export const SPEED_BANDS = [
  { max: 10, color: "#22c55e", label: "<10" },
  { max: 25, color: "#84cc16", label: "10–25" },
  { max: 40, color: "#eab308", label: "25–40" },
  { max: 55, color: "#f59e0b", label: "40–55" },
  { max: 70, color: "#f97316", label: "55–70" },
  { max: Infinity, color: "#ef4444", label: "70+" },
];
const bandOf = (speed: number | null) => SPEED_BANDS.findIndex((b) => (speed ?? 0) < b.max);

function PickHandler({ track, onPick }: { track: TrackPoint[]; onPick: (i: number) => void }) {
  useMapEvents({
    click(e) {
      const cos = Math.cos((e.latlng.lat * Math.PI) / 180);
      let best = track[0];
      let bestD = Infinity;
      for (const p of track) {
        const d = (p.lat - e.latlng.lat) ** 2 + ((p.lon - e.latlng.lng) * cos) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      onPick(best.i);
    },
  });
  return null;
}

export default function RouteMap({
  track,
  marker,
  breaks = [],
  onPick,
}: {
  track: TrackPoint[];
  marker: LatLngTuple | null;
  breaks?: BreakPin[];
  onPick: (i: number) => void;
}) {
  // Split the route into runs of the same speed band, sharing the boundary point so there are no gaps.
  const segments = useMemo(() => {
    const out: { color: string; positions: LatLngTuple[] }[] = [];
    let current: { band: number; positions: LatLngTuple[] } | null = null;
    for (const p of track) {
      const pos: LatLngTuple = [p.lat, p.lon];
      const band = bandOf(p.speed);
      if (!current || current.band !== band) {
        if (current) out.push({ color: SPEED_BANDS[current.band].color, positions: [...current.positions, pos] });
        current = { band, positions: [pos] };
      } else {
        current.positions.push(pos);
      }
    }
    if (current) out.push({ color: SPEED_BANDS[current.band].color, positions: current.positions });
    return out;
  }, [track]);

  const bounds = useMemo(() => track.map((p) => [p.lat, p.lon] as LatLngTuple), [track]);
  const first = track[0];
  const last = track[track.length - 1];

  return (
    <MapContainer bounds={bounds} boundsOptions={{ padding: [24, 24] }} style={{ height: "100%" }} scrollWheelZoom={false}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {segments.map((s, k) => (
        <Polyline key={k} positions={s.positions} pathOptions={{ color: s.color, weight: 5 }} />
      ))}
      <CircleMarker center={[first.lat, first.lon]} radius={6} pathOptions={{ color: "#ffffff", fillColor: "#22c55e", fillOpacity: 1, weight: 2 }} />
      <CircleMarker center={[last.lat, last.lon]} radius={6} pathOptions={{ color: "#ffffff", fillColor: "#ef4444", fillOpacity: 1, weight: 2 }} />
      {breaks.map((b, k) => (
        <Marker key={k} position={[b.lat, b.lon]} icon={breakIcon}>
          <Tooltip>Break · {Math.round(b.seconds / 60)} min</Tooltip>
        </Marker>
      ))}
      {marker && (
        <CircleMarker center={marker} radius={9} pathOptions={{ color: "#ffffff", fillColor: "#3b82f6", fillOpacity: 1, weight: 3 }} />
      )}
      <PickHandler track={track} onPick={onPick} />
    </MapContainer>
  );
}
