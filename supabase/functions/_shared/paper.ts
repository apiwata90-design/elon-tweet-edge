// Live paper trading rules (phase 3) — same rules as backtest v2 (C_V2 in scripts/backtest.ts),
// but fills use the real top-of-book from gamma instead of mid ± estimated spread.
//   entry : edge = P(side) − (ask + fee(ask)) ≥ +5pp, ask within [0.05, 0.95], best bucket × side
//   exit  : (bid − fee(bid)) ≥ P(side) + 3pp → take_profit · P(side) − (ask + fee(ask)) ≤ −5pp → stop_loss · else hold to settle
//   fee   : taker r·f·(1−f) per share on buy and sell (r = gamma feeSchedule.rate) · settlement has no fee
//   No side quotes come from the Yes book: ask_no = 1 − bid_yes, bid_no = 1 − ask_yes
import type { Bucket, Market } from "./common.ts";
import { cdf, DAY, nowcast, type Series } from "./model.ts";

export const STAKE = 10, ENTRY = 0.05, TAKE = 0.03, STOP = -0.05, BAND_LO = 0.05, BAND_HI = 0.95, FEE_DEFAULT = 0.01;
export const AGENTS = [{ name: "2x", xs: [24.5, 17.5] }, { name: "3x", xs: [16, 7, 2.5] }];
export const BASELINE = "avg7d";
export type Side = "yes" | "no";

export const marketType = (m: { s: number; e: number }) => {
  const d = (m.e - m.s) / DAY;
  return d < 3 ? "48h" : d > 6 && d < 8 ? "7d" : null;
};
export const feeRate = (b: Bucket) => b.fee ?? FEE_DEFAULT;
export const fee = (f: number, r: number) => r * f * (1 - f);
export const buyCost = (ask: number, r: number) => ask + fee(ask, r);
export const sellNet = (bid: number, r: number) => bid - fee(bid, r);
const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0 && v < 1;

/** quotes of one side, derived from the Yes book */
export function sideQuote(b: Bucket, side: Side) {
  const a = ok(b.ask) ? b.ask : null, d = ok(b.bid) ? b.bid : null;
  return side === "yes" ? { ask: a, bid: d } : { ask: d == null ? null : 1 - d, bid: a == null ? null : 1 - a };
}

/** P(final count in bucket) for every bucket, from the shared nowcast model */
export function modelP(m: Market, cur: number, series: Series, now: number) {
  const { x } = nowcast({ series, now, s: m.s, e: m.e, cur });
  const P = cdf(x);
  return m.buckets.map((b) => Math.max(0, P(b.lo, b.hi)));
}

export type Entry = { i: number; side: Side; ask: number; cost: number; edge: number; Ps: number; r: number };
/** best entry over buckets × sides (fill within the 5–95¢ band) */
export function bestEntry(m: Market, P: number[]): Entry | null {
  let best: Entry | null = null;
  m.buckets.forEach((b, i) => {
    for (const side of ["yes", "no"] as const) {
      const { ask } = sideQuote(b, side);
      if (ask == null || ask < BAND_LO || ask > BAND_HI) continue;
      const r = feeRate(b), cost = buyCost(ask, r), Ps = side === "yes" ? P[i] : 1 - P[i], edge = Ps - cost;
      if (cost < 1 && (!best || edge > best.edge)) best = { i, side, ask, cost, edge, Ps, r };
    }
  });
  return best;
}

export type ExitCheck = { why: "take_profit" | "stop_loss" | null; Ps: number; net: number | null; edge: number | null; bid: number | null; ask: number | null };
/** exit rule for an open position at a checkpoint */
export function exitCheck(b: Bucket, side: Side, Pyes: number): ExitCheck {
  const { ask, bid } = sideQuote(b, side), r = feeRate(b), Ps = side === "yes" ? Pyes : 1 - Pyes;
  const net = bid == null ? null : sellNet(bid, r), edge = ask == null ? null : Ps - buyCost(ask, r);
  const why = net != null && net >= Ps + TAKE ? "take_profit" : edge != null && edge <= STOP && net != null ? "stop_loss" : null;
  return { why, Ps, net, edge, bid, ask };
}
