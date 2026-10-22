"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(mode: "in" | "up") {
    setBusy(true);
    setMessage(null);
    const { data, error } =
      mode === "in"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) return setMessage(error.message);
    if (data.session) router.replace("/rides");
    else setMessage("Check your email to confirm the account, then sign in.");
  }

  return (
    <>
      <h1>Sign in</h1>
      <form className="card" onSubmit={(e) => { e.preventDefault(); submit("in"); }}>
        <label>Email</label>
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label>Password</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" type="submit" disabled={busy}>Sign in</button>
          <button type="button" disabled={busy} onClick={() => submit("up")}>Create account</button>
        </div>
        {message && <p className="muted">{message}</p>}
      </form>
    </>
  );
}
