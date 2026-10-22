# OBD2-Web : Ride Logger

Logs rides from a BLE ELM327 OBD2 adapter plus phone GPS to Supabase, and shows ride history with route map, charts and fault codes. Built for a Suzuki Access 125 (OBD-II over ISO 15765-4 CAN, 11-bit, 500 kbaud, ECU `7E8`).

## Setup

1. **Supabase**: create a project, open the SQL editor and run `supabase/schema.sql`.
   Under Authentication → URL Configuration, set the Site URL to your Vercel URL.
2. **Local env**: copy `.env.example` to `.env.local` and fill in the project URL and anon key
   (Project Settings → API).
3. **Run locally**: `npm install && npm run dev`.
4. **Deploy**: push to GitHub, import the repo in Vercel, and add the same two env vars.

## Riding with an iPhone

Safari doesn't support Web Bluetooth, so open the deployed site in the free **Bluefy** browser.

1. Close Car Scanner (the adapter only accepts one connection).
2. Turn the ignition on, open the site in Bluefy, go to **Ride** and tap **Connect OBD**.
3. Tap **Start ride**. Keep Bluefy in the foreground with the screen on; readings are sent every 5 s
   and are saved on the phone if you lose signal.
4. Tap **Stop ride** at the end, then view it under **History**.

Without the adapter, rides are still logged with GPS only.

## Notes

- **Fuel is estimated.** The ECU has no MAF sensor, so fuel flow is calculated from MAP, RPM and
  intake temperature for a 124 cc engine (`estimateFuelRate` in `lib/obd/pids.ts`). Tune `ve`
  against a real fill-up to calibrate it.
- Distance uses the integrated OBD speed when connected, otherwise GPS.
- Unplug the adapter when parked so it doesn't drain the scooter battery.
