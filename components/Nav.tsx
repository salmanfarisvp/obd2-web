"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRecorder } from "@/components/RecorderProvider";
import { formatDuration } from "@/lib/geo";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";

export default function Nav() {
  const path = usePathname();
  const session = useSession();
  const { adapter, phase, stats } = useRecorder();
  const link = (href: string, label: string) => (
    <Link href={href} className={`link ${path === href ? "active" : ""}`}>{label}</Link>
  );
  return (
    <nav>
      <Link href="/" className="brand">🛵 Ride Logger</Link>
      {phase === "recording" ? (
        <Link href="/ride" className="pill bad">● Rec {formatDuration(stats.seconds)}</Link>
      ) : adapter ? (
        <Link href="/ride" className="pill ok">● OBD</Link>
      ) : null}
      {session && link("/ride", "Ride")}
      {session && link("/rides", "History")}
      {session ? (
        <a className="link" href="#" onClick={(e) => { e.preventDefault(); supabase.auth.signOut(); }}>Sign out</a>
      ) : (
        link("/login", "Sign in")
      )}
    </nav>
  );
}
