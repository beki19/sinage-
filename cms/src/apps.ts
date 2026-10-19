/**
 * Live data behind the information widgets: weather (Open-Meteo), exchange rates (open.er-api.com) and
 * calendars (iCal links). Fetched by the CMS, cached, and shared by all screens, so screens never need keys.
 */

const cache = new Map<string, { at: number; value: unknown }>();

/** Fetches JSON or text with a time limit, reusing a recent answer, and the last good one if the source fails. */
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  try {
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (hit) return hit.value as T;
    throw err;
  }
}

async function getJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "SignageCMS/1.6" } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered HTTP ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

// ---------- weather ----------

export interface Place {
  name: string;
  country: string;
  admin: string;
  lat: number;
  lon: number;
}

/** Finds cities by name for the weather widget's "find city" box. */
export async function findPlaces(query: string): Promise<Place[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=${encodeURIComponent(query)}`;
  const data = await cached(`geo:${query.toLowerCase()}`, 86_400_000, () => getJson(url));
  const results = (data.results as Record<string, unknown>[] | undefined) ?? [];
  return results.map((r) => ({
    name: String(r.name ?? ""), country: String(r.country ?? ""), admin: String(r.admin1 ?? ""),
    lat: Number(r.latitude), lon: Number(r.longitude),
  }));
}

export async function weather(lat: number, lon: number, units: "c" | "f") {
  const url = "https://api.open-meteo.com/v1/forecast?timezone=auto&forecast_days=5"
    + `&latitude=${lat}&longitude=${lon}`
    + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day"
    + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
    + (units === "f" ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "");
  const d = await cached(`wx:${lat.toFixed(2)},${lon.toFixed(2)},${units}`, 15 * 60_000, () => getJson(url));
  const cur = d.current as Record<string, number>;
  const daily = d.daily as Record<string, (number | string)[]>;
  return {
    current: {
      temp: cur.temperature_2m, feels: cur.apparent_temperature, humidity: cur.relative_humidity_2m,
      wind: cur.wind_speed_10m, code: cur.weather_code, day: cur.is_day === 1,
    },
    days: (daily.time ?? []).map((t, i) => ({
      date: String(t), code: Number(daily.weather_code[i]), max: Number(daily.temperature_2m_max[i]),
      min: Number(daily.temperature_2m_min[i]), rain: Number(daily.precipitation_probability_max?.[i] ?? 0),
    })),
    units,
  };
}

// ---------- exchange rates ----------

/** How many [base] one unit of each currency buys, e.g. base ETB: { USD: 155.2, EUR: 168.9 }. */
export async function exchangeRates(base: string, currencies: string[]) {
  const d = await cached("fx:USD", 60 * 60_000, () => getJson("https://open.er-api.com/v6/latest/USD"));
  const rates = d.rates as Record<string, number>;
  if (!rates?.[base]) throw new Error(`No rates for ${base}`);
  const out: Record<string, number> = {};
  for (const c of currencies) if (rates[c]) out[c] = rates[base] / rates[c];
  return { base, rates: out, updated: String(d.time_last_update_utc ?? "") };
}

// ---------- calendars (iCal) ----------

export interface CalEvent {
  title: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
}

/** "20261019T090000Z", "20261019T090000" (local) or "20261019" (all day). */
function icsDate(v: string): { date: Date; allDay: boolean } | null {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  return { date: z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * Events from an iCal feed that touch the next [days] days, soonest first. Times without a zone are read
 * as the CMS computer's local time. Simple daily and weekly repeats are expanded; other repeats show their first date.
 */
export async function calendarEvents(url: string, days = 7): Promise<CalEvent[]> {
  const text = await cached(`ics:${url}`, 10 * 60_000, async () => {
    const res = await fetch(url.replace(/^webcal:/i, "https:"), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`The calendar answered HTTP ${res.status}`);
    return (await res.text()).slice(0, 5_000_000);
  });
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + days * 86_400_000);
  const out: CalEvent[] = [];
  let ev: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { ev = {}; continue; }
    if (line === "END:VEVENT" && ev) {
      const start = icsDate(ev.DTSTART ?? "");
      if (start) {
        const end = icsDate(ev.DTEND ?? "") ?? { date: new Date(start.date.getTime() + (start.allDay ? 86_400_000 : 3_600_000)), allDay: start.allDay };
        const length = end.date.getTime() - start.date.getTime();
        const unescape = (s?: string) => (s ?? "").replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
        const add = (s: Date) => {
          const e = new Date(s.getTime() + length);
          if (e > from && s < to) out.push({ title: unescape(ev!.SUMMARY) || "(No title)", location: unescape(ev!.LOCATION), start: s.toISOString(), end: e.toISOString(), allDay: start.allDay });
        };
        const rule = Object.fromEntries((ev.RRULE ?? "").split(";").filter(Boolean).map((p) => p.split("=")));
        if (rule.FREQ === "DAILY" || rule.FREQ === "WEEKLY") {
          const step = Math.max(1, Number(rule.INTERVAL) || 1);
          const until = rule.UNTIL ? icsDate(rule.UNTIL)?.date : undefined;
          const byDay = rule.BYDAY ? rule.BYDAY.split(",").map((d: string) => DAY_CODES.indexOf(d.slice(-2))) : [start.date.getDay()];
          for (let d = new Date(start.date); d < to && (!until || d <= until); d = new Date(d.getTime() + 86_400_000)) {
            const daysSince = Math.round((d.getTime() - start.date.getTime()) / 86_400_000);
            const ok = rule.FREQ === "DAILY" ? daysSince % step === 0 : byDay.includes(d.getDay()) && Math.floor(daysSince / 7) % step === 0;
            if (ok) add(d);
          }
        } else {
          add(start.date);
        }
      }
      ev = null;
      continue;
    }
    if (!ev) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).split(";")[0].toUpperCase();
    if (!(key in ev)) ev[key] = line.slice(i + 1);
  }
  return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 40);
}
