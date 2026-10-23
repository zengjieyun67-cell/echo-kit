/** Generic rhythm judging helpers (engine-side, game-agnostic). */
export type Grade = 'perfect' | 'good' | 'miss';
export interface Windows { perfect: number; good: number }
export const DEFAULT_WINDOWS: Windows = { perfect: 0.05, good: 0.11 };

/** grade a signed timing error (seconds) */
export function grade(err: number, w: Windows = DEFAULT_WINDOWS): Grade {
  const a = Math.abs(err); return a <= w.perfect ? 'perfect' : a <= w.good ? 'good' : 'miss';
}
/** nearest target time to t in a sorted array, or null if none within maxDist */
export function nearest(sorted: number[], t: number, maxDist = Infinity): number | null {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < t) lo = m + 1; else hi = m; }
  let best: number | null = null;
  for (const i of [lo - 1, lo]) if (i >= 0 && i < sorted.length && Math.abs(sorted[i] - t) <= maxDist && (best === null || Math.abs(sorted[i] - t) < Math.abs(best - t))) best = sorted[i];
  return best;
}
/** gentle snap: pull t toward the nearest target by strength (0..1) if within range */
export function snap(sorted: number[], t: number, range: number, strength = 1): number {
  const n = nearest(sorted, t, range); return n === null ? t : t + (n - t) * strength;
}
/** input buffer: keeps a press alive for `life` seconds so an early press still counts when the action becomes legal */
export class InputBuffer {
  private t: number | null = null;
  constructor(readonly life = 0.12) {}
  push(t: number) { this.t = t; }
  /** consume if a press happened within `life` before now */
  take(now: number): number | null { if (this.t !== null && now - this.t <= this.life) { const t = this.t; this.t = null; return t; } this.t = null; return null; }
  get pending() { return this.t; }
}
