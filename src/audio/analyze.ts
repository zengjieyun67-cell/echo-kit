/**
 * Ported from the author's earlier FACE OFF 3D project (src/rhythm/analyze.ts) as a reusable library.
 * Extended: per-frame band ENERGY (not just flux) for low / high bands, used by structure.ts for mood/brightness.
 *
 * Beat analysis for an uploaded song, entirely in the browser.
 *  1. decode → mono 11 025 Hz (OfflineAudioContext resamples and downmixes)
 *  2. STFT (512-point Hann, hop 128 ≈ 11.6 ms) → log-magnitude spectral flux in three bands (low / mid / high)
 *  3. onset envelope = weighted band flux, with a moving-average baseline removed and normalised
 *  4. tempo = autocorrelation of the envelope, weighted toward 120 BPM (log-normal prior), folded into 85–180 BPM
 *  5. beats = dynamic-programming beat tracker (Ellis 2007): best path of onsets spaced ≈ one period apart,
 *     so tempo drift and live drumming are followed
 *  6. downbeat = bar phase whose beats carry the most low-band (kick) energy
 */
export const SR = 11025, N = 512, HOP = 128, FPS = SR / HOP;

export interface Analysis {
  duration: number; bpm: number; beats: number[]; downbeat: number;
  fps: number; onset: Float32Array; low: Float32Array; mid: Float32Array; high: Float32Array; rms: Float32Array;
  /** per-frame log-magnitude energy below 250 Hz and above 2 kHz (for brightness / mood) */
  lowE: Float32Array; highE: Float32Array;
  /** 12-band log-spaced spectral profile (70-2400 Hz), frames x 12, for timbral novelty */
  spec: Float32Array; nb: number;
  /** seconds of the first and last musically active beat */
  activeStart: number; activeEnd: number;
}

export type AnalyzeProgress = (p: number, label: string) => void;
const tick = () => new Promise(r => setTimeout(r, 0));

export async function decodeFile(file: File | ArrayBuffer, ctx?: BaseAudioContext): Promise<AudioBuffer> {
  const buf = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const c = ctx ?? new OfflineAudioContext(1, 1, 44100);
  try { return await c.decodeAudioData(buf.slice(0)); }
  catch { throw new Error('Could not decode this audio file. Please use MP3, M4A, WAV, OGG or FLAC.'); }
}

async function toMono(buffer: AudioBuffer): Promise<Float32Array> {
  const len = Math.ceil(buffer.duration * SR);
  const off = new OfflineAudioContext(1, len, SR);
  const src = off.createBufferSource(); src.buffer = buffer; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  return out.getChannelData(0).slice();
}

/** in-place iterative radix-2 FFT */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

function movingAvg(x: Float32Array, half: number) {
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
const percentile = (x: ArrayLike<number>, p: number) => { const a = Array.from(x).sort((m, n) => m - n); return a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0; };

/** empirical latency of a flux peak relative to the true onset (measured on synthetic tracks with known beats) */
export const ONSET_LAG = -0.003;

export async function analyze(buffer: AudioBuffer, onProgress?: AnalyzeProgress): Promise<Analysis> {
  onProgress?.(0.05, 'Resampling');
  const x = await toMono(buffer);
  const frames = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const lowE = new Float32Array(frames), highE = new Float32Array(frames);
  const low = new Float32Array(frames), mid = new Float32Array(frames), high = new Float32Array(frames), rms = new Float32Array(frames);
  const re = new Float32Array(N), im = new Float32Array(N);
  const NB = 12, bandOf = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) { const f = k * SR / N; if (f >= 70 && f < 2400) bandOf[k] = Math.min(NB - 1, Math.floor(Math.log2(f / 70) / Math.log2(2400 / 70) * NB)); }
  const spec = new Float32Array(frames * NB);
  let prev = new Float32Array(N / 2), cur = new Float32Array(N / 2);
  const LOW_END = Math.round(200 / (SR / N)), MID_END = Math.round(2200 / (SR / N));
  const LOWE_END = Math.round(250 / (SR / N)), HIGHE_START = Math.round(2000 / (SR / N));
  onProgress?.(0.15, 'Spectral analysis');
  for (let f = 0; f < frames; f++) {
    const o = f * HOP; let e = 0;
    for (let i = 0; i < N; i++) { const v = x[o + i] || 0; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    rms[f] = Math.sqrt(e / N);
    fft(re, im);
    let l = 0, m = 0, h = 0, le = 0, he = 0;
    for (let k = 1; k < N / 2; k++) {
      const mag = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = mag; const d = mag - prev[k];
      if (bandOf[k] >= 0) spec[f * NB + bandOf[k]] += mag;
      if (k <= LOWE_END) le += mag; else if (k >= HIGHE_START) he += mag;
      if (d > 0) { if (k <= LOW_END) l += d; else if (k <= MID_END) m += d; else h += d; }
    }
    low[f] = l; mid[f] = m / 3; high[f] = h / 4; lowE[f] = le / LOWE_END; highE[f] = he / (N / 2 - HIGHE_START);
    const t = prev; prev = cur; cur = t;
    if ((f & 4095) === 0) { onProgress?.(0.15 + 0.45 * f / frames, 'Spectral analysis'); await tick(); }
  }
  // onset envelope, baseline removed
  const raw = new Float32Array(frames);
  for (let f = 0; f < frames; f++) raw[f] = low[f] * 1.1 + mid[f] + high[f] * 0.7;
  const base = movingAvg(raw, Math.round(FPS * 0.25));
  const onset = new Float32Array(frames); let mean = 0;
  for (let f = 0; f < frames; f++) { onset[f] = Math.max(0, raw[f] - base[f]); mean += onset[f]; }
  mean /= frames; let sd = 0; for (let f = 0; f < frames; f++) sd += (onset[f] - mean) ** 2; sd = Math.sqrt(sd / frames) || 1;
  for (let f = 0; f < frames; f++) onset[f] /= sd;
  for (const band of [low, mid, high]) { const b = movingAvg(band, Math.round(FPS * 0.25)); let s = 0; for (let f = 0; f < frames; f++) { band[f] = Math.max(0, band[f] - b[f]); s += band[f] * band[f]; } s = Math.sqrt(s / frames) || 1; for (let f = 0; f < frames; f++) band[f] /= s; }
  onProgress?.(0.65, 'Estimating tempo');
  await tick();
  const bpm = estimateTempo(onset);
  onProgress?.(0.8, 'Tracking beats');
  await tick();
  const period = FPS * 60 / bpm;
  const beatFrames = trackBeats(onset, period);
  const beatsAll = beatFrames.map(f => Math.max(0, (f * HOP + N / 2) / SR - ONSET_LAG));
  // musically active span: beats whose local loudness is above a fraction of the song's typical loudness
  const loud = percentile(rms, 0.6) || 1e-3;
  const isActive = (t: number) => { const f = Math.round(t * FPS); let m = 0; for (let k = f - 8; k <= f + 8; k++) if (k >= 0 && k < frames) m = Math.max(m, rms[k]); return m > loud * 0.18; };
  const beats = beatsAll.filter(t => t < buffer.duration - 0.05);
  const actives = beats.filter(isActive);
  const activeStart = actives[0] ?? 0, activeEnd = actives[actives.length - 1] ?? buffer.duration;
  const downbeat = findDownbeat(beats, low, mid, high, spec, NB);
  onProgress?.(1, 'Done');
  return { duration: buffer.duration, bpm, beats, downbeat, fps: FPS, onset, low, mid, high, rms, lowE, highE, spec, nb: NB, activeStart, activeEnd };
}

export function estimateTempo(onset: Float32Array, lo = 60, hi = 200): number {
  const minLag = Math.floor(FPS * 60 / hi), maxLag = Math.ceil(FPS * 60 / lo);
  const n = onset.length; const ac = new Float32Array(maxLag + 2);
  for (let L = minLag; L <= maxLag + 1; L++) { let s = 0; for (let i = L; i < n; i++) s += onset[i] * onset[i - L]; ac[L] = s / (n - L); }
  // reinforce each lag with its double (bar-level periodicity) to stabilise against half/double errors
  let best = minLag, bestV = -Infinity;
  for (let L = minLag; L <= maxLag; L++) {
    const bpm = FPS * 60 / L;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.8) ** 2);
    const v = (ac[L] + 0.5 * (2 * L <= maxLag + 1 ? ac[2 * L] : 0)) * prior;
    if (v > bestV) { bestV = v; best = L; }
  }
  // parabolic refinement
  const a = ac[best - 1] ?? ac[best], b = ac[best], c = ac[best + 1] ?? ac[best];
  const den = a - 2 * b + c; const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
  let bpm = FPS * 60 / (best + THREE_CLAMP(shift, -0.5, 0.5));
  while (bpm < 85) bpm *= 2; while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}
function THREE_CLAMP(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }

/** Ellis dynamic-programming beat tracker; returns beat frame indices (sub-frame refined) */
export function trackBeats(onset: Float32Array, period: number, tightness = 120): number[] {
  const n = onset.length;
  // smooth with a Gaussian of width period/32 so the tracker prefers onset peaks
  const sig = Math.max(1, period / 32); const R = Math.ceil(sig * 3); const g: number[] = [];
  for (let k = -R; k <= R; k++) g.push(Math.exp(-0.5 * (k / sig) ** 2));
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -R; k <= R; k++) { const j = i + k; if (j >= 0 && j < n) s += onset[j] * g[k + R]; } local[i] = s; }
  const score = new Float32Array(n), back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0, arg = -1;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (arg < 0 || v > best) { best = v; arg = p; }
    }
    score[t] = local[t] + (arg >= 0 ? Math.max(0, best) : 0); back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // last beat: highest cumulative score in the final period that sits on a local peak of the envelope
  let end = n - 1, bestEnd = -Infinity;
  for (let t = Math.max(0, n - Math.round(period * 1.5)); t < n; t++) if (score[t] > bestEnd) { bestEnd = score[t]; end = t; }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
  beats.reverse();
  // extend the grid backwards into a quiet intro so every bar has a beat (notes will skip silent parts anyway)
  while (beats.length && beats[0] - period > 0) beats.unshift(beats[0] - period);
  // sub-frame peak refinement on the smoothed envelope
  return beats.map(b => {
    const i = Math.round(b); if (i <= 0 || i >= n - 1) return b;
    const a = local[i - 1], c = local[i], d = local[i + 1]; const den = a - 2 * c + d;
    return den < 0 ? i + THREE_CLAMP(0.5 * (a - d) / den, -0.5, 0.5) : b;
  });
}

function findDownbeat(beats: number[], low: Float32Array, mid: Float32Array, high: Float32Array, spec: Float32Array, NB: number) {
  if (beats.length < 12) return 0;
  const at = (env: Float32Array, t: number) => { const f = Math.round(t * FPS); let m = 0; for (let k = f - 3; k <= f + 3; k++) if (k >= 0 && k < env.length) m = Math.max(m, env[k]); return m; };
  const L = beats.map(t => at(low, t)), B = beats.map(t => at(mid, t) + 0.5 * at(high, t));
  // harmonic / timbral novelty: chords and sections change on bar lines. Mean spectral profile over the beat
  // before vs. after each beat (prefix sums keep it linear), cosine distance; the attack itself is skipped.
  const frames = spec.length / NB; const pre = new Float64Array((frames + 1) * NB);
  for (let f = 0; f < frames; f++) for (let b = 0; b < NB; b++) pre[(f + 1) * NB + b] = pre[f * NB + b] + spec[f * NB + b];
  const mean = (t0: number, t1: number) => { const a = Math.max(0, Math.floor(t0 * FPS)), c = Math.min(frames, Math.max(a + 1, Math.floor(t1 * FPS))); const v = new Float64Array(NB); for (let b = 0; b < NB; b++) v[b] = (pre[c * NB + b] - pre[a * NB + b]) / (c - a); return v; };
  const cosd = (u: Float64Array, v: Float64Array) => { let d = 0, x = 0, y = 0; for (let b = 0; b < NB; b++) { d += u[b] * v[b]; x += u[b] * u[b]; y += v[b] * v[b]; } return 1 - d / Math.sqrt(x * y || 1); };
  const H = beats.map((t, i) => (i < 1 || i + 1 >= beats.length) ? 0 : cosd(mean(beats[i - 1] + 0.03, t - 0.03), mean(t + 0.03, beats[i + 1] - 0.03)));
  const sum = (ph: number, fn: (i: number) => number) => { let s = 0, n = 0; for (let i = ph; i + 3 < beats.length; i += 4) { s += fn(i); n++; } return s / Math.max(1, n); };
  const back = [0, 1, 2, 3].map(ph => sum(ph, i => B[i + 1] + B[i + 3] - B[i] - B[i + 2]));
  const harm = [0, 1, 2, 3].map(ph => sum(ph, i => H[i]));
  const kick = [0, 1, 2, 3].map(ph => sum(ph, i => L[i] - L[i + 2]));
  const hs = Math.max(1e-6, ...harm.map(Math.abs)), ks = Math.max(1e-6, ...kick.map(Math.abs)), bs = Math.max(1e-6, ...back.map(Math.abs));
  const score = [0, 1, 2, 3].map(ph => 1.0 * back[ph] / bs + 2.0 * harm[ph] / hs + 0.15 * kick[ph] / ks);
  return score.indexOf(Math.max(...score));
}

/** peak onset strength around time t (seconds) in an envelope */
export function strengthAt(env: Float32Array, t: number, win = 0.035) {
  const a = Math.max(0, Math.floor((t - win) * FPS)), b = Math.min(env.length - 1, Math.ceil((t + win) * FPS)); let m = 0;
  for (let i = a; i <= b; i++) if (env[i] > m) m = env[i];
  return m;
}
export function rmsAt(rms: Float32Array, t0: number, t1: number) {
  const a = Math.max(0, Math.floor(t0 * FPS)), b = Math.min(rms.length - 1, Math.ceil(t1 * FPS)); let s = 0, n = 0;
  for (let i = a; i <= b; i++) { s += rms[i]; n++; }
  return n ? s / n : 0;
}
