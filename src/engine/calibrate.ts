/**
 * Input-latency calibration: play a metronome on the song's AudioContext, the player taps along,
 * offset = median(tapTime - nearestClick). Robust to a few wild taps. Engine-side, game-agnostic.
 */
export interface CalibrationResult { offset: number; taps: number; spread: number }

export function medianOffset(errors: number[]): CalibrationResult | null {
  if (errors.length < 4) return null;
  const a = [...errors].sort((x, y) => x - y), med = a[a.length >> 1];
  const kept = a.filter(e => Math.abs(e - med) < 0.08); if (kept.length < 4) return null;
  const m = kept[kept.length >> 1], spread = Math.sqrt(kept.reduce((s, e) => s + (e - m) ** 2, 0) / kept.length);
  return { offset: m, taps: kept.length, spread };
}

export class Calibrator {
  private clicks: number[] = []; private errs: number[] = []; private nodes: AudioScheduledSourceNode[] = [];
  constructor(readonly ctx: AudioContext, readonly bpm = 100, readonly count = 16) {}
  start() {
    const p = 60 / this.bpm, t0 = this.ctx.currentTime + 0.5; this.clicks = []; this.errs = [];
    for (let i = 0; i < this.count; i++) {
      const t = t0 + i * p, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.frequency.value = i % 4 ? 880 : 1320; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + 0.1); this.nodes.push(o); this.clicks.push(t);
    }
    return t0 + this.count * p; // end time (ctx seconds)
  }
  /** call from a keydown/pointerdown handler with event.timeStamp */
  tap(eventTimeStamp: number) {
    const lat = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    const t = this.ctx.currentTime - Math.max(0, (performance.now() - eventTimeStamp) / 1000) - Math.min(lat, 0.2);
    let best = Infinity; for (const c of this.clicks) if (Math.abs(t - c) < Math.abs(best)) best = t - c;
    if (Math.abs(best) < 0.25) this.errs.push(best);
  }
  result() { return medianOffset(this.errs); }
  cancel() { this.nodes.forEach(n => { try { n.stop(); } catch { /* done */ } }); this.nodes = []; }
}
