"use client";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type Series = { key: string; name: string; color: string; axis?: "left" | "right" };
// `idx` points back to the full-resolution reading so the chart can drive the replay cursor.
export type ChartRow = { min: number; idx: number } & Record<string, number | null>;

export default function RideChart({
  data,
  series,
  cursorMin,
  onScrub,
}: {
  data: ChartRow[];
  series: Series[];
  cursorMin?: number;
  onScrub?: (idx: number) => void;
}) {
  const hasRight = series.some((s) => s.axis === "right");
  return (
    <div className="chart">
      <ResponsiveContainer>
        <LineChart
          data={data}
          margin={{ top: 8, right: hasRight ? 0 : 12, left: -16, bottom: 0 }}
          onMouseMove={(state) => {
            const row = state?.activePayload?.[0]?.payload as ChartRow | undefined;
            if (row && onScrub) onScrub(row.idx);
          }}
        >
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
          {cursorMin !== undefined && <ReferenceLine yAxisId="left" x={cursorMin} stroke="#e6e9ef" strokeDasharray="3 3" />}
          {series.map((s) => (
            <Line key={s.key} yAxisId={s.axis ?? "left"} dataKey={s.key} name={s.name} stroke={s.color} dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
