"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";

export default function Nav() {
  const path = usePathname();
  const session = useSession();
  const link = (href: string, label: string) => (
    <Link href={href} className={`link ${path === href ? "active" : ""}`}>{label}</Link>
  );
  return (
    <nav>
      <Link href="/" className="brand">🛵 Ride Logger</Link>
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
