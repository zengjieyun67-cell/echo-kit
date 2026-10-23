/**
 * Musical structure on top of the beat analysis:
 *  - smoothed energy curve (0..1, 10 Hz)
 *  - brightness / mood curve (high-band vs low-band energy, 0 = dark/warm, 1 = bright/airy)
 *  - section segmentation: bar-level novelty (energy + brightness + timbre) → boundaries snapped to bar lines,
 *    each section tagged calm / build / peak / release
 *  - the "contrast" section: the quietest section that comes after the first peak (used for the night moment)
 */
import { Analysis } from './analyze';

export type SectionKind = 'calm' | 'build' | 'peak' | 'release';
export interface Section {
  index: number; kind: SectionKind; start: number; end: number;
  /** mean energy / brightness inside the section, 0..1 */
  energy: number; brightness: number;
  /** true for the quiet section after the peak (a natural contrast moment) */
  contrast: boolean;
}
export interface Structure {
  rate: number; energy: Float32Array; brightness: Float32Array;
  sections: Section[]; bars: number[]; beatPeriod: number;
  /** strong onsets (seconds, strength 0..1) for collectible light notes */
  strongOnsets: { t: number; s: number }[];
}

const pct = (a: ArrayLike<number>, p: number) => { const s = Array.from(a).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))] ?? 0; };

function smooth(x: Float32Array, half: number) {
  const out = new Float32Array(x.length); let s = 0, n = 0;
  for (let i = 0; i < Math.min(x.length, half); i++) { s += x[i]; n++; }
  for (let i = 0; i < x.length; i++) {
    const add = i + half, rem = i - half - 1;
    if (add < x.length) { s += x[add]; n++; }
    if (rem >= 0) { s -= x[rem]; n--; }
    out[i] = s / Math.max(1, n);
  }
  return out;
}

/** resample a frame-rate envelope to `rate` Hz by block averaging */
function resample(x: Float32Array, fps: number, rate: number, dur: number) {
  const n = Math.max(1, Math.ceil(dur * rate)); const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i / rate * fps), b = Math.max(a + 1, Math.floor((i + 1) / rate * fps)); let s = 0, c = 0;
    for (let k = a; k < b && k < x.length; k++) { s += x[k]; c++; }
    out[i] = c ? s / c : (i ? out[i - 1] : 0);
  }
  return out;
}
function normalise(x: Float32Array, lo = 0.05, hi = 0.95) {
  const a = pct(x, lo), b = pct(x, hi), d = (b - a) || 1;
  for (let i = 0; i < x.length; i++) x[i] = Math.min(1, Math.max(0, (x[i] - a) / d));
  return x;
}

export function buildStructure(an: Analysis): Structure {
  const RATE = 10;
  // energy: RMS in dB-ish, smoothed ~1.2 s
  const loud = new Float32Array(an.rms.length);
  for (let i = 0; i < loud.length; i++) loud[i] = Math.log10(1e-4 + an.rms[i]);
  const energy = normalise(smooth(resample(loud, an.fps, RATE, an.duration), 6));
  // brightness: share of high-band energy
  const br = new Float32Array(an.lowE.length);
  for (let i = 0; i < br.length; i++) br[i] = an.highE[i] / (an.lowE[i] + an.highE[i] + 1e-6);
  const brightness = normalise(smooth(resample(br, an.fps, RATE, an.duration), 10));

  // bar grid from beats + downbeat
  const beatPeriod = an.beats.length > 1 ? (an.beats[an.beats.length - 1] - an.beats[0]) / (an.beats.length - 1) : 0.5;
  const bars: number[] = [];
  for (let i = an.downbeat; i < an.beats.length; i += 4) bars.push(an.beats[i]);
  if (!bars.length || bars[0] > 0.5) bars.unshift(0);

  // bar-level features
  const at = (curve: Float32Array, t0: number, t1: number) => { const a = Math.max(0, Math.floor(t0 * RATE)), b = Math.min(curve.length, Math.max(a + 1, Math.ceil(t1 * RATE))); let s = 0; for (let k = a; k < b; k++) s += curve[k]; return s / Math.max(1, b - a); };
  const nb = an.nb, frames = an.spec.length / nb;
  const prof = (t0: number, t1: number) => { const a = Math.max(0, Math.floor(t0 * an.fps)), b = Math.min(frames, Math.max(a + 1, Math.floor(t1 * an.fps))); const v = new Float64Array(nb); for (let f = a; f < b; f++) for (let k = 0; k < nb; k++) v[k] += an.spec[f * nb + k]; let n = 0; for (let k = 0; k < nb; k++) n += v[k] * v[k]; n = Math.sqrt(n) || 1; for (let k = 0; k < nb; k++) v[k] /= n; return v; };
  const barEnd = (i: number) => i + 1 < bars.length ? bars[i + 1] : an.duration;
  const feats = bars.map((t, i) => ({ e: at(energy, t, barEnd(i)), b: at(brightness, t, barEnd(i)), p: prof(t, barEnd(i)) }));

  // novelty at each bar line: compare W bars before vs W bars after
  const W = 4; const nov = new Float32Array(bars.length);
  for (let i = 1; i < bars.length; i++) {
    const A = feats.slice(Math.max(0, i - W), i), B = feats.slice(i, Math.min(bars.length, i + W));
    if (!A.length || !B.length) continue;
    const m = (arr: typeof feats, k: 'e' | 'b') => arr.reduce((s, f) => s + f[k], 0) / arr.length;
    const pa = new Float64Array(nb), pb = new Float64Array(nb);
    for (const f of A) for (let k = 0; k < nb; k++) pa[k] += f.p[k] / A.length;
    for (const f of B) for (let k = 0; k < nb; k++) pb[k] += f.p[k] / B.length;
    let d = 0, x = 0, y = 0; for (let k = 0; k < nb; k++) { d += pa[k] * pb[k]; x += pa[k] ** 2; y += pb[k] ** 2; }
    const timbre = 1 - d / Math.sqrt(x * y || 1);
    nov[i] = 1.6 * Math.abs(m(B, 'e') - m(A, 'e')) + 0.6 * Math.abs(m(B, 'b') - m(A, 'b')) + 8 * timbre;
  }
  // pick boundaries: local maxima above a threshold, at least MIN bars apart, strongest first
  const MIN = Math.max(4, Math.round(7 / Math.max(0.25, beatPeriod * 4)));  // ≥ ~7 s and ≥ 4 bars
  const thr = pct(nov.filter((_, i) => i > 0), 0.6);
  const cand = Array.from(nov, (v, i) => ({ v, i })).filter(c => c.i > 0 && c.v > thr && c.v >= (nov[c.i - 1] ?? 0) && c.v >= (nov[c.i + 1] ?? 0)).sort((a, b) => b.v - a.v);
  const chosen: number[] = [];
  const maxSections = Math.max(3, Math.min(12, Math.round(an.duration / 18)));
  for (const c of cand) {
    if (chosen.length >= maxSections - 1) break;
    if (c.i < MIN / 2 || bars.length - c.i < MIN / 2) continue;
    if (chosen.every(j => Math.abs(j - c.i) >= MIN)) chosen.push(c.i);
  }
  chosen.sort((a, b) => a - b);
  // split very long sections once at their strongest inner novelty (long stretches usually hide a build-up)
  const barIdx = [0, ...chosen, bars.length];
  for (let k = 0; k < barIdx.length - 1; k++) {
    const a = barIdx[k], b = barIdx[k + 1]; const len = (b < bars.length ? bars[b] : an.duration) - bars[a];
    if (len < 36 || b - a < 10) continue;
    let best = -1, bv = -1; for (let i = a + Math.max(4, Math.floor((b - a) * 0.2)); i <= b - Math.max(4, Math.floor((b - a) * 0.2)); i++) if (nov[i] > bv) { bv = nov[i]; best = i; }
    if (best > 0) chosen.push(best);
  }
  chosen.sort((a, b) => a - b);
  const bounds = [0, ...chosen.map(i => bars[i]), an.duration];

  const raw = bounds.slice(0, -1).map((s, i) => ({ start: i === 0 ? 0 : s, end: bounds[i + 1], energy: at(energy, s, bounds[i + 1]), brightness: at(brightness, s, bounds[i + 1]) }));
  // label relative to the song's own dynamic range
  // dynamic range from sections that are long enough to matter (a 3 s silent tail would skew everything)
  const es = raw.filter(r => r.end - r.start >= 6).map(r => r.energy); if (!es.length) es.push(...raw.map(r => r.energy));
  const eMax = Math.max(...es), eMin = Math.min(...es), span = (eMax - eMin) || 1;
  const sections: Section[] = raw.map((r, i) => {
    const rel = (r.energy - eMin) / span;
    const prev = raw[i - 1], next = raw[i + 1];
    let kind: SectionKind;
    if (i === 0 && raw.length > 2) kind = rel < 0.5 ? 'calm' : 'build';   // songs open, they rarely start at the peak
    else if (rel >= 0.8) kind = 'peak';
    else if (rel <= 0.3) kind = (prev && prev.energy > r.energy + 0.1 * span && i > 0) ? 'release' : 'calm';
    else if (next && next.energy > r.energy) kind = 'build';
    else if (prev && prev.energy > r.energy) kind = 'release';
    else kind = 'build';
    return { index: i, kind, start: r.start, end: r.end, energy: r.energy, brightness: r.brightness, contrast: false };
  });
  if (!sections.some(s => s.kind === 'peak')) { const top = sections.reduce((a, b) => b.energy > a.energy ? b : a); top.kind = 'peak'; }
  // contrast moment: quietest section after the first peak (not the last few seconds of the outro)
  const firstPeak = sections.findIndex(s => s.kind === 'peak');
  const lastIdx = sections.length - 1;
  let after = sections.filter(s => s.index > firstPeak && s.index < lastIdx && s.end - s.start >= 6 && s.kind !== 'peak');
  if (!after.length) after = sections.filter(s => s.index > firstPeak && s.end - s.start >= 6 && s.kind !== 'peak');
  if (after.length) { const q = after.reduce((a, b) => b.energy < a.energy ? b : a); q.contrast = true; if (q.kind === 'build') q.kind = 'release'; }

  // strong onsets: peaks of the onset envelope above the 97.5th percentile, ≥ 0.45 s apart
  const strongOnsets: { t: number; s: number }[] = [];
  const thrO = pct(an.onset, 0.975), maxO = pct(an.onset, 0.998) || 1; let last = -1;
  for (let f = 2; f < an.onset.length - 2; f++) {
    const v = an.onset[f];
    if (v > thrO && v >= an.onset[f - 1] && v >= an.onset[f + 1] && v >= an.onset[f - 2] && v >= an.onset[f + 2]) {
      const t = f / an.fps; if (t - last < 0.45) continue;
      strongOnsets.push({ t, s: Math.min(1, v / maxO) }); last = t;
    }
  }
  return { rate: RATE, energy, brightness, sections, bars, beatPeriod, strongOnsets };
}

export function sampleCurve(curve: Float32Array, rate: number, t: number) {
  const x = t * rate, i = Math.floor(x), f = x - i;
  const a = curve[Math.max(0, Math.min(curve.length - 1, i))], b = curve[Math.max(0, Math.min(curve.length - 1, i + 1))];
  return a + (b - a) * f;
}
export function sectionAt(st: Structure, t: number): Section {
  const s = st.sections; for (let i = s.length - 1; i >= 0; i--) if (t >= s[i].start) return s[i];
  return s[0];
}
