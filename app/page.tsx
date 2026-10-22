"use client";
import Link from "next/link";
import { useSession } from "@/lib/useSession";

export default function Home() {
  const session = useSession();
  return (
    <>
      <h1>Ride Logger</h1>
      <div className="card">
        <p>Log rides from your BLE OBD2 adapter and phone GPS, then review routes and engine data.</p>
        <p className="muted">
          On iPhone, open this site in the <b>Bluefy</b> browser so it can reach Bluetooth. Keep the screen on while riding.
        </p>
        <div className="row">
          {session ? (
            <>
              <Link href="/ride"><button className="primary">Start a ride</button></Link>
              <Link href="/rides"><button>Ride history</button></Link>
            </>
          ) : (
            <Link href="/login"><button className="primary">Sign in</button></Link>
          )}
        </div>
      </div>
    </>
  );
}
