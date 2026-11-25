// Polymarket event slug for an xtracker tracking (pure TS, shared by Edge Functions and scripts/backtest.ts).
// Most trackings carry marketLink; ~25% of older ones do not → derive candidates from the title:
//   "Elon Musk # tweets November 20 - November 27, 2026?" → elon-musk-of-tweets-november-20-november-27-2026
export function slugCandidates(t: { marketLink?: string | null; title: string }): string[] {
  if (t.marketLink) return [String(t.marketLink).split("/").filter(Boolean).pop()!];
  const core = t.title.replace(/^Elon Musk #\s*tweets\s*/i, "").replace(/\?$/, "").trim();
  const base = "elon-musk-of-tweets-" + core.toLowerCase().replace(/,/g, "").replace(/\s+-\s+/g, "-").replace(/\s+/g, "-");
  return [base, base.replace(/-20\d\d$/, "")];
}
