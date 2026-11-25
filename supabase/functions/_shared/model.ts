// Nowcast model shared by Edge Functions and scripts/backtest.ts (pure TS, no imports).
// Port of simulate() in template.html:
//   analogs = posts in the same remaining window shifted back k whole days (k = kmin … kmin+59)
//   trend   L = 1 + w·(rate7d / rate60d − 1), w = 0.5
//   x_i     = cur + Poisson(analog_random · L)   for 20,000 sims
// Differences: seeded RNG option (reproducible backtests) and analog windows that start before the
// series begins are skipped instead of counted as 0.

export const HR = 3_600_000, DAY = 86_400_000;
export type Series = { t0: number; h: number[] };          // hourly counts, h[i] = posts in [t0+i·HR, t0+(i+1)·HR)
export type BucketQ = { t: string; lo: number; hi: number; ask?: number | null; bid?: number | null; mid?: number | null };
export type BucketP = BucketQ & { p: number; edge: number | null };

/** hourly series from sorted/unsorted post timestamps (ms); only posts strictly before upTo are counted */
export function buildSeries(times: number[], t0: number, upTo: number): Series {
  const n = Math.max(0, Math.floor((upTo - t0) / HR) + 1), h = new Array<number>(n).fill(0);
  for (const t of times) if (t >= t0 && t < upTo) h[Math.floor((t - t0) / HR)]++;
  return { t0, h };
}

/** cumulative count between two instants, linear inside an hour (same as mkR in template.html) */
export function makeR(s: Series) {
  const P = new Float64Array(s.h.length + 1);
  for (let i = 0; i < s.h.length; i++) P[i + 1] = P[i] + s.h[i];
  const at = (ms: number) => {
    const x = (ms - s.t0) / HR;
    if (x <= 0) return 0;
    if (x >= s.h.length) return P[s.h.length];
    const i = Math.floor(x);
    return P[i] + s.h[i] * (x - i);
  };
  return (a: number, b: number) => at(b) - at(a);
}

export function rng(seed: number) {              // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pois(l: number, rnd: () => number) {
  if (l <= 0) return 0;
  if (l > 40) {
    let u = 0, v = 0;
    while (!u) u = rnd();
    while (!v) v = rnd();
    return Math.max(0, Math.round(l + Math.sqrt(l) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
  }
  const L = Math.exp(-l);
  let k = 0, p = 1;
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
}

export type NowcastIn = { series: Series; now: number; s: number; e: number; cur: number; w?: number; sims?: number; boost?: number; seed?: number };
export type NowcastOut = { x: Int32Array; L: number; rem: number; analogs: number[] };

export function nowcast(o: NowcastIn): NowcastOut {
  const { series, now, s, e, cur } = o, w = o.w ?? 0.5, sims = o.sims ?? 20_000, boost = o.boost ?? 0;
  const rnd = o.seed == null ? Math.random : rng(o.seed);
  const R = makeR(series);
  const from = Math.max(now, s), rem = (e - from) / HR;
  if (rem <= 0) return { x: new Int32Array(1).fill(cur), L: 1, rem: 0, analogs: [] };
  const kmin = Math.ceil((e - now) / DAY), an: number[] = [];
  for (let k = kmin; k < kmin + 60; k++) if (from - k * DAY >= series.t0) an.push(R(from - k * DAY, e - k * DAY));
  const l7 = R(now - 7 * DAY, now) / 7, l60 = R(now - 60 * DAY, now) / 60;
  const L = 1 + w * ((l60 ? l7 / l60 : 1) - 1);
  const x = new Int32Array(sims);
  if (!an.length) { x.fill(cur); return { x, L, rem, analogs: an }; }
  for (let i = 0; i < sims; i++) x[i] = cur + pois(Math.max(0, an[(rnd() * an.length) | 0] * L + boost), rnd);
  return { x, L, rem, analogs: an };
}

export function probIn(x: Int32Array, lo: number, hi: number) {
  let c = 0;
  for (let i = 0; i < x.length; i++) if (x[i] >= lo && x[i] <= hi) c++;
  return c / x.length;
}
export const probAtLeast = (x: Int32Array, k: number) => probIn(x, k, 2 ** 31 - 1);

/** cumulative histogram of sims → P(lo ≤ X ≤ hi) in O(1) per bucket (same result as probIn) */
export function cdf(x: Int32Array) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < x.length; i++) { if (x[i] < mn) mn = x[i]; if (x[i] > mx) mx = x[i]; }
  const C = new Float64Array(mx - mn + 2);               // C[k] = #sims with X < mn + k
  for (let i = 0; i < x.length; i++) C[x[i] - mn + 1]++;
  for (let k = 1; k < C.length; k++) C[k] += C[k - 1];
  const below = (v: number) => (v <= mn ? 0 : v > mx ? x.length : C[v - mn]);
  return (lo: number, hi: number) => (below(Math.min(hi, mx) + 1) - below(lo)) / x.length * (hi < lo ? 0 : 1);
}

/** P per bucket + Yes edge (P − ask, falls back to mid when there is no ask) */
export function bucketProbs(x: Int32Array, buckets: BucketQ[]): BucketP[] {
  const P = cdf(x);
  return buckets.map((b) => {
    const p = Math.max(0, P(b.lo, b.hi)), px = b.ask ?? b.mid ?? null;
    return { ...b, p, edge: px == null ? null : p - px };
  });
}

/** edge Yes = P − ask: 🟢🟢 ≥ +10pp | 🟢 +5..+10 | 🟡 −5..+5 | 🔴 −10..−5 | 🔴🔴 ≤ −10 */
export function edgeLevel(edge: number | null): 2 | 1 | 0 | -1 | -2 | null {
  if (edge == null) return null;
  if (edge >= 0.10) return 2;
  if (edge >= 0.05) return 1;
  if (edge > -0.05) return 0;
  if (edge > -0.10) return -1;
  return -2;
}
export const ICON: Record<string, string> = { "2": "🟢🟢", "1": "🟢", "0": "🟡", "-1": "🔴", "-2": "🔴🔴", "null": "⚪" };
export const edgeIcon = (edge: number | null) => ICON[String(edgeLevel(edge))];
