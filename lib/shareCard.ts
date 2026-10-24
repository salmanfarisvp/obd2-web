import { haversineKm } from "./geo";
import type { Reading } from "./supabase";

// Ride share card: the route coloured by speed over a dimmed OpenStreetMap background, with the
// ride and engine numbers laid over it. Rendered on a canvas, exported as a PNG.

export type CardFormat = "square" | "story";
export type CardStat = { label: string; value: string; unit?: string };
export type CardInput = {
  readings: Reading[];
  title: string;
  subtitle: string; // date and vehicle
  main: CardStat[]; // the big four: distance, riding time, avg, top speed
  engine: CardStat[]; // smaller row: RPM, coolant, fuel, mileage, cost…
  format: CardFormat;
  hideEnds: boolean;
};

// Same bands as the route map.
const BANDS = [
  { max: 10, color: "#22c55e" },
  { max: 25, color: "#84cc16" },
  { max: 40, color: "#eab308" },
  { max: 55, color: "#f59e0b" },
  { max: 70, color: "#f97316" },
  { max: Infinity, color: "#ef4444" },
];
const bandColor = (kmh: number | null) => BANDS.find((b) => (kmh ?? 0) < b.max)!.color;

const PRIVACY_KM = 0.2;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

type Pt = { lat: number; lon: number; speed: number | null };

/** Drop the first and last ~200 m so the card doesn't show where you live or park. */
function trimEnds(pts: Pt[]): Pt[] {
  const cut = (list: Pt[]) => {
    let km = 0;
    for (let i = 1; i < list.length; i++) {
      km += haversineKm(list[i - 1].lat, list[i - 1].lon, list[i].lat, list[i].lon);
      if (km >= PRIVACY_KM) return list.slice(i);
    }
    return [];
  };
  return cut(cut(pts).reverse()).reverse();
}

function project(lat: number, lon: number, zoom: number) {
  const size = 256 * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => resolve(null), 8000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  });
}

export async function renderShareCard(input: CardInput): Promise<Blob> {
  const W = 1080;
  const H = input.format === "story" ? 1920 : 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Base, in case tiles don't load.
  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, "#1e3a8a");
  base.addColorStop(1, "#0b1020");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  let pts: Pt[] = input.readings.flatMap((r) =>
    r.lat !== null && r.lon !== null ? [{ lat: r.lat, lon: r.lon, speed: r.speed ?? r.gps_speed }] : [],
  );
  if (input.hideEnds) pts = trimEnds(pts);

  // Where the route sits: the upper part, leaving room for the numbers below.
  const region = input.format === "story"
    ? { x: 90, y: 230, w: W - 180, h: 800 }
    : { x: 90, y: 120, w: W - 180, h: 400 };

  if (pts.length > 1) {
    // Highest zoom at which the route fits, then scale up to fill the region.
    let zoom = 17;
    let box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    for (; zoom > 2; zoom--) {
      const p = pts.map((q) => project(q.lat, q.lon, zoom));
      box = {
        minX: Math.min(...p.map((q) => q.x)), maxX: Math.max(...p.map((q) => q.x)),
        minY: Math.min(...p.map((q) => q.y)), maxY: Math.max(...p.map((q) => q.y)),
      };
      if (box.maxX - box.minX <= region.w && box.maxY - box.minY <= region.h) break;
    }
    const k = Math.min(2, region.w / Math.max(1, box.maxX - box.minX), region.h / Math.max(1, box.maxY - box.minY));
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const rcx = region.x + region.w / 2;
    const rcy = region.y + region.h / 2;
    const toCanvas = (lat: number, lon: number) => {
      const p = project(lat, lon, zoom);
      return { x: (p.x - cx) * k + rcx, y: (p.y - cy) * k + rcy };
    };

    // Map tiles covering the whole card.
    const tiles = 2 ** zoom;
    const x0 = Math.floor((cx - rcx / k) / 256);
    const x1 = Math.floor((cx + (W - rcx) / k) / 256);
    const y0 = Math.max(0, Math.floor((cy - rcy / k) / 256));
    const y1 = Math.min(tiles - 1, Math.floor((cy + (H - rcy) / k) / 256));
    const jobs: Promise<void>[] = [];
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const wrapped = ((tx % tiles) + tiles) % tiles;
        jobs.push(loadTile(zoom, wrapped, ty).then((img) => {
          if (img) ctx.drawImage(img, (tx * 256 - cx) * k + rcx, (ty * 256 - cy) * k + rcy, 256 * k + 1, 256 * k + 1);
        }));
      }
    }
    await Promise.all(jobs);

    // Desaturate and dim the map so the route and text stand out.
    ctx.globalCompositeOperation = "saturation";
    ctx.fillStyle = "hsl(0, 0%, 50%)";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(5, 8, 16, 0.5)";
    ctx.fillRect(0, 0, W, H);

    // Route: dark casing, then speed-coloured segments.
    const c = pts.map((q) => ({ ...toCanvas(q.lat, q.lon), speed: q.speed }));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = 16;
    ctx.beginPath();
    c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.lineWidth = 9;
    for (let i = 1; i < c.length; i++) {
      ctx.strokeStyle = bandColor(c[i].speed);
      ctx.beginPath();
      ctx.moveTo(c[i - 1].x, c[i - 1].y);
      ctx.lineTo(c[i].x, c[i].y);
      ctx.stroke();
    }
    const dot = (p: { x: number; y: number }, color: string) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    };
    dot(c[0], "#22c55e");
    dot(c[c.length - 1], "#ef4444");
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `500 36px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("No GPS route for this ride", W / 2, region.y + region.h / 2);
    ctx.textAlign = "left";
  }

  // Darken the bottom so the numbers are easy to read.
  const textTop = input.format === "story" ? 1080 : 600;
  const fade = ctx.createLinearGradient(0, textTop - 160, 0, H);
  fade.addColorStop(0, "rgba(5,8,16,0)");
  fade.addColorStop(0.35, "rgba(5,8,16,0.85)");
  fade.addColorStop(1, "rgba(5,8,16,0.97)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, textTop - 160, W, H - textTop + 160);

  ctx.shadowColor = "rgba(0,0,0,0.7)";
  ctx.shadowBlur = 8;
  ctx.textBaseline = "alphabetic";
  const pad = 70;

  // Header.
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = `700 30px ${FONT}`;
  ctx.fillText("🛵  RIDE LOGGER", pad, 80);

  // Title and subtitle.
  let y = textTop + (input.format === "story" ? 40 : 10);
  ctx.fillStyle = "#fff";
  ctx.font = `800 ${input.format === "story" ? 64 : 54}px ${FONT}`;
  ctx.fillText(fit(ctx, input.title, W - pad * 2), pad, y);
  y += 48;
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `500 30px ${FONT}`;
  ctx.fillText(fit(ctx, input.subtitle, W - pad * 2), pad, y);

  // Big numbers: four across on a square, two by two on a story.
  y += input.format === "story" ? 110 : 90;
  const bigCols = input.format === "story" ? 2 : 4;
  const big = input.format === "story" ? 96 : 66;
  y = grid(ctx, input.main, { x: pad, y, w: W - pad * 2, cols: bigCols, value: big, label: 24, rowGap: big + 70 });

  // Engine details: one row of five on a square, two rows of three on a story.
  const engine = input.engine.slice(0, input.format === "story" ? 6 : 5);
  if (engine.length) {
    y += input.format === "story" ? 30 : 10;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.shadowBlur = 0;
    ctx.fillRect(pad, y - 40, W - pad * 2, 2);
    ctx.shadowBlur = 8;
    y += 30;
    const engCols = input.format === "story" ? 3 : Math.min(5, engine.length);
    grid(ctx, engine, { x: pad, y, w: W - pad * 2, cols: engCols, value: input.format === "story" ? 54 : 40, label: 20, rowGap: 120 });
  }

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't create image"))), "image/png"));
}

/** Labelled numbers in columns; returns the y after the last row. */
function grid(
  ctx: CanvasRenderingContext2D,
  stats: CardStat[],
  o: { x: number; y: number; w: number; cols: number; value: number; label: number; rowGap: number },
) {
  const colW = o.w / o.cols;
  stats.forEach((s, i) => {
    const x = o.x + (i % o.cols) * colW;
    const top = o.y + Math.floor(i / o.cols) * o.rowGap;
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = `700 ${o.label}px ${FONT}`;
    ctx.fillText(s.label.toUpperCase(), x, top);
    // Shrink long values (e.g. "1h 23m") to fit the column rather than cutting them off.
    let size = o.value;
    const unitWidth = () => (s.unit ? (ctx.font = `600 ${Math.round(size * 0.4)}px ${FONT}`, ctx.measureText(s.unit).width + 8) : 0);
    const valueWidth = () => ((ctx.font = `800 ${size}px ${FONT}`), ctx.measureText(s.value).width);
    while (size > o.value * 0.6 && valueWidth() + unitWidth() > colW - 16) size -= 2;
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${size}px ${FONT}`;
    const value = fit(ctx, s.value, colW - 16);
    ctx.fillText(value, x, top + o.value + 6);
    if (s.unit) {
      const vw = ctx.measureText(value).width;
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = `600 ${Math.round(size * 0.4)}px ${FONT}`;
      if (vw + 8 + ctx.measureText(s.unit).width < colW - 8) ctx.fillText(s.unit, x + vw + 8, top + o.value + 6);
    }
  });
  return o.y + Math.ceil(stats.length / o.cols) * o.rowGap;
}

/** Shorten text with an ellipsis to fit a width. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > width) t = t.slice(0, -1);
  return t + "…";
}

/** "Morning ride" etc., Strava-style, from the start time. */
export function rideTitle(startedAt: string, note: string | null) {
  if (note) return note;
  const h = new Date(startedAt).getHours();
  return h < 5 ? "Night ride" : h < 12 ? "Morning ride" : h < 17 ? "Afternoon ride" : h < 21 ? "Evening ride" : "Night ride";
}
