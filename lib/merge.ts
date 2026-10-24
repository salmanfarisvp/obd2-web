import { supabase, Ride } from "./supabase";
import { fetchReadings, summarize } from "./rideSummary";

/**
 * Merge rides into the earliest one: move the others' readings and fault codes over, recompute
 * the totals (the gaps between them become breaks), join their notes, then delete the emptied rides.
 */
export async function mergeRides(rides: Ride[]): Promise<Ride> {
  const sorted = [...rides].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const [target, ...others] = sorted;

  // Needs migration 004 (break columns); check before moving anything so a merge never half-happens.
  const ready = await supabase.from("rides").select("breaks").limit(1);
  if (ready.error) throw new Error("Run supabase/migrations/004_breaks_and_merge.sql in Supabase first.");

  for (const other of others) {
    const moved = await supabase.from("readings").update({ ride_id: target.id }).eq("ride_id", other.id);
    if (moved.error) throw moved.error;
    await supabase.from("fault_codes").update({ ride_id: target.id }).eq("ride_id", other.id);
  }

  const readings = await fetchReadings(target.id);
  const totals = summarize(readings);
  const ended_at = readings.length ? readings[readings.length - 1].ts : sorted[sorted.length - 1].ended_at;
  const note = sorted.map((r) => r.note).filter(Boolean).join(" · ") || null;
  const updated = await supabase.from("rides").update({ ...totals, ended_at, note }).eq("id", target.id);
  if (updated.error) throw updated.error;

  // Their readings now belong to the target, so deleting them removes only the empty ride rows.
  const removed = await supabase.from("rides").delete().in("id", others.map((o) => o.id));
  if (removed.error) throw removed.error;

  return { ...target, ...totals, ended_at, note };
}
