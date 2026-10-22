"use client";
import { useState } from "react";
import { supabase } from "@/lib/supabase";

export default function RideNote({ rideId, initial }: { rideId: string; initial: string | null }) {
  const [note, setNote] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial ?? "");
  const [status, setStatus] = useState<string | null>(null);

  async function save() {
    setStatus("Saving…");
    const { error } = await supabase.from("rides").update({ note: note.trim() || null }).eq("id", rideId);
    if (error) return setStatus(`Couldn't save: ${error.message}`);
    setSaved(note);
    setStatus("Saved");
  }

  return (
    <div>
      <textarea
        rows={2}
        placeholder="Add a note, e.g. office commute, filled petrol…"
        value={note}
        onChange={(e) => { setNote(e.target.value); setStatus(null); }}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={save} disabled={note === saved}>Save note</button>
        {status && <span className="muted">{status}</span>}
      </div>
    </div>
  );
}
