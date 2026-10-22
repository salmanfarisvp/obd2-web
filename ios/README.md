# Ride Logger for iPhone

Native logger that keeps recording with the screen locked and the phone in your pocket.
It uses the same Supabase project and login as the website, and has everything the website
has: ride history with map replay, fuel log, mileage and costs, and profile.

## What it does

- Remembers your adapter. iOS reconnects to it by itself when the scooter is switched on,
  even in the background.
- Starts a ride when the engine starts and saves it when the power goes, with the same rules as
  the web app (adapter off: immediately; ECU silent: 10 s; engine off with ignition on: 60 s).
- Logs OBD readings and GPS every second, in the background too.
- Queues uploads on the phone and sends them when there's signal.
- GPS-only rides when there's no adapter.
- **History tab**: totals, ride list, and per ride the stats, a note you can edit, an Apple Maps
  route coloured by speed, a replay slider with play (10×/30×/60×) showing the readings at each
  moment, charts you can touch to jump to a moment, and fault codes. Per vehicle: mileage (real or
  estimated), fuel used, fuel cost and cost per km; per ride: fuel, mileage, cost and cost per km.
- **Fuel tab**: add fill-ups by amount or litres (the other is worked out from the price), mark
  full tanks, see real mileage and spending, swipe to delete.
- **Profile tab**: currency, petrol price, vehicles with tank capacity, and sign out.

## Build and install (free Apple ID)

1. Install **Xcode** from the Mac App Store and open it once.
2. Xcode → Settings → Accounts → **+** → sign in with your Apple ID.
3. Create `ios/RideLogger/Secrets.swift` from `ios/Secrets.example.swift` with your Supabase URL
   and **publishable** key (skip if it already exists; it isn't committed).
4. Open `ios/RideLogger.xcodeproj`.
5. Select the **RideLogger** target → **Signing & Capabilities** → **Team**: choose your
   Apple ID ("Personal Team"). If Xcode says the bundle identifier is taken, change
   `io.github.salmanfarisvp.ridelogger` to something unique.
6. Connect the iPhone with a cable, unlock it and tap **Trust**.
7. On the iPhone: Settings → Privacy & Security → **Developer Mode** → on (it restarts).
8. In Xcode, pick your iPhone at the top and press **Run** (▶).
9. First launch only: Settings → General → VPN & Device Management → your Apple ID → **Trust**.

With a free Apple ID the app stops opening after 7 days. Plug in and press Run again; your
login and queued data are kept. A paid Apple Developer account removes that limit.

## First ride

1. Open the app and sign in with your website account.
2. Allow Bluetooth, and allow location **Always** when asked (needed for logging with the screen locked).
3. Close Car Scanner and Bluefy, switch the scooter on, tap **Choose adapter** and pick it.
4. Ride. You can lock the phone. The blue location indicator shows it's logging.
