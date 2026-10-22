"use client";
import "leaflet/dist/leaflet.css";
import { CircleMarker, MapContainer, Polyline, TileLayer } from "react-leaflet";
import type { LatLngTuple } from "leaflet";

export default function RouteMap({ points }: { points: LatLngTuple[] }) {
  return (
    <MapContainer bounds={points} boundsOptions={{ padding: [24, 24] }} style={{ height: "100%" }} scrollWheelZoom={false}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Polyline positions={points} pathOptions={{ color: "#3b82f6", weight: 4 }} />
      <CircleMarker center={points[0]} radius={7} pathOptions={{ color: "#22c55e", fillOpacity: 1 }} />
      <CircleMarker center={points[points.length - 1]} radius={7} pathOptions={{ color: "#ef4444", fillOpacity: 1 }} />
    </MapContainer>
  );
}
