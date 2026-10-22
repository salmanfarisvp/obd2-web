"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/useSession";

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (session === null) router.replace("/login");
  }, [session, router]);
  if (!session) return <p className="muted">Loading…</p>;
  return <>{children}</>;
}
