"use client";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type Series = { key: string; name: string; color: string; axis?: "left" | "right" };

export default function RideChart({ data, series }: { data: Record<string, number | null>[]; series: Series[] }) {
  const hasRight = series.some((s) => s.axis === "right");
  return (
    <div className="chart">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: hasRight ? 0 : 12, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="#262c36" vertical={false} />
          <XAxis dataKey="min" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "#8b93a1", fontSize: 12 }} tickFormatter={(m) => `${Math.round(m)}m`} />
          <YAxis yAxisId="left" tick={{ fill: "#8b93a1", fontSize: 12 }} />
          {hasRight && <YAxis yAxisId="right" orientation="right" tick={{ fill: "#8b93a1", fontSize: 12 }} />}
          <Tooltip
            contentStyle={{ background: "#171b22", border: "1px solid #262c36", borderRadius: 8 }}
            labelFormatter={(m) => `${Number(m).toFixed(1)} min`}
            formatter={(v: number) => (typeof v === "number" ? v.toFixed(1) : v)}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.map((s) => (
            <Line key={s.key} yAxisId={s.axis ?? "left"} dataKey={s.key} name={s.name} stroke={s.color} dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
