# OBD2-Web : Ride Logger

Logs rides from a BLE ELM327 OBD2 adapter plus phone GPS to Supabase, and shows ride history with route map, charts and fault codes. Built for a Suzuki Access 125 (OBD-II over ISO 15765-4 CAN, 11-bit, 500 kbaud, ECU `7E8`).

## Features

- **Automatic rides**: connect the adapter once. A ride starts when the engine starts and is saved
  with its date and time as soon as the power goes off. No start/stop buttons needed.
- **Auto-reconnect**: when the scooter is switched on again, the app reconnects to the adapter by
  itself and the next engine start becomes a new ride.
- **Live engine data**: RPM, speed, coolant and intake air temperature, throttle, engine load,
  manifold pressure, timing, fuel trims, battery voltage and estimated fuel rate.
- **Riding vs idle time**: each ride records riding time (moving), idle time (engine on at 0 km/h),
  number of stops and riding average speed.
- **Ride notes**: add a note when a ride is saved, and view or edit it later in History.
- **Ride history**: totals across all rides, plus per-ride route map (OpenStreetMap), speed/RPM,
  temperature, throttle/load and battery charts, and fault codes.
- **Ride replay**: drag the time slider or press play (10×/30×/60×) to move a marker along the
  route and see speed, RPM, throttle, temperatures and more at that moment. Touch a chart or tap the
  route to jump there. The route is coloured by speed.
- **Profile**: currency symbol, petrol price per litre, and your vehicles with tank capacity.
- **Fuel log**: record each fill-up by amount paid or litres (the other is worked out from the
  price), optionally marked as a full tank. If the ECU reports a fuel level, fill-ups are detected
  automatically and offered for saving.
- **Mileage and cost**: per vehicle and per ride: fuel used, km/L, cost and cost per km. Real
  mileage comes from the fuel log (km ridden ÷ litres filled between fill-ups) and, once reliable,
  calibrates the engine-based fuel estimates.
- **Fault codes**: stored DTCs are read when the adapter connects and attached to the ride.
- **Offline-safe**: readings are kept on the phone and uploaded when the connection is back.
  Rides interrupted by a reload or closed app still get their totals in History.
- **GPS-only rides**: works without the adapter too, using phone GPS.
- **Stays connected across pages**: browse History while a ride keeps recording.

## Setup

1. **Supabase**: create a project, open the SQL editor and run `supabase/schema.sql`.
   If you created the tables earlier, run the files in `supabase/migrations/` that you haven't
   run yet, in order, instead.
   Under Authentication → URL Configuration, set the Site URL to your Vercel URL.
2. **Local env**: copy `.env.example` to `.env.local` and fill in the project URL and publishable key
   (Project Settings → API Keys). Never use the secret key here; it would be exposed in the browser.
3. **Run locally**: `npm install && npm run dev`.
4. **Deploy**: push to GitHub, import the repo in Vercel, and add the same two env vars.

## Riding with an iPhone

**Recommended: the native app** in [`ios/`](ios/README.md). It logs with the screen locked and
uses the same account and database as the website.

Without it, Safari doesn't support Web Bluetooth, so open the deployed site in the free
**Bluefy** browser instead (logging pauses if the screen locks):

1. Close Car Scanner (the adapter only accepts one connection).
2. Turn the ignition on, open the site in Bluefy, go to **Ride** and tap **Connect OBD**.
3. Ride. Logging starts when the engine starts. Keep Bluefy in the foreground with the screen on.
4. Switch off. The ride is saved straight away; add a note on the Ride page or later in **History**.

When a ride ends:

| What happens | When the ride is saved |
|---|---|
| Adapter loses power (ignition off) | Immediately |
| ECU stops answering | After 10 s |
| Engine off with ignition still on | After 60 s (so a quick restart stays one ride) |
| You tap **End ride now** | Immediately |

Without the adapter, tap **Start GPS-only ride** to log with GPS only.

### Limits

- Reloading the page or closing Bluefy drops the Bluetooth link; tap **Connect OBD** again.
- iOS can suspend Bluefy in the background or with the screen locked, which pauses logging.
- Automatic reconnection after the adapter powers back on depends on the browser allowing it;
  if it doesn't, tap **Pick adapter again**.

## Notes

- **Fuel is estimated.** The ECU has no MAF sensor, so fuel flow is calculated from MAP, RPM and
  intake temperature for a 124 cc engine (`estimateFuelRate` in `lib/obd/pids.ts`). Tune `ve`
  against a real fill-up to calibrate it.
- Distance uses the integrated OBD speed when connected, otherwise GPS.
- **Real mileage with partial fills** is approximate at first: the tank level at the first and last
  fill-up isn't known, which can be off by up to a tankful. After about three tankfuls of fill-ups
  (16 L for a 5.3 L tank) it's treated as reliable. Two full-tank fill-ups give an exact figure.
- Unplug the adapter when parked so it doesn't drain the scooter battery.
