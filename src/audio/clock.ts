/**
 * SongPlayer + MusicClock.
 *  SongPlayer: plays a decoded AudioBuffer through  source → lowpass ("restore" filter) → gain → destination,
 *    with pause/resume via AudioContext suspend, and setRestore(0..1) which opens the filter / volume.
 *  MusicClock: song position derived from AudioContext.currentTime (never from frame time), plus the musical
 *    view of that position: beat index + phase, bar, section, energy, brightness, and onset/beat/section events.
 */
import { Analysis } from './analyze';
import { Structure, Section, sampleCurve, sectionAt } from './structure';

export class SongPlayer {
  readonly ctx: AudioContext;
  private src: AudioBufferSourceNode | null = null;
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
  /** bus for sound effects (not affected by the restore filter) */
  readonly sfx: GainNode;
  private startCtx = 0; private offset = 0; private playing = false;
  buffer: AudioBuffer | null = null;
  /** player-calibrated input offset in seconds (positive = player hits late); saved in localStorage */
  inputOffset = Number(localStorage.getItem('echo.inputOffset') ?? 0) || 0;
  setInputOffset(s: number) { this.inputOffset = Math.max(-0.25, Math.min(0.25, s)); localStorage.setItem('echo.inputOffset', String(this.inputOffset)); }
  onEnded: (() => void) | null = null;

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'interactive' });
    this.filter = this.ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = 0.7;
    this.gain = this.ctx.createGain();
    this.filter.connect(this.gain).connect(this.ctx.destination);
    this.sfx = this.ctx.createGain(); this.sfx.gain.value = 0.5; this.sfx.connect(this.ctx.destination);
    this.setRestore(0, true);
  }
  /** 0 = muffled & quiet (≈320 Hz lowpass, 40 % volume), 1 = the full song */
  setRestore(r: number, immediate = false) {
    r = Math.max(0, Math.min(1, r));
    const f = 320 * Math.pow(18000 / 320, r), g = 0.4 + 0.6 * r, now = this.ctx.currentTime;
    if (immediate) { this.filter.frequency.value = f; this.gain.gain.value = g; return; }
    this.filter.frequency.setTargetAtTime(f, now, 0.25); this.gain.gain.setTargetAtTime(g, now, 0.25);
  }
  async play(buffer: AudioBuffer, from = 0) {
    this.stop(); this.buffer = buffer;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const s = this.ctx.createBufferSource(); s.buffer = buffer; s.connect(this.filter);
    s.onended = () => { if (this.src === s && this.playing) { this.playing = false; this.onEnded?.(); } };
    this.offset = from; this.startCtx = this.ctx.currentTime + 0.06;
    s.start(this.startCtx, from); this.src = s; this.playing = true;
  }
  stop() { if (this.src) { this.playing = false; try { this.src.stop(); } catch { /* already stopped */ } this.src.disconnect(); this.src = null; } }
  pause() { return this.ctx.suspend(); }
  resume() { return this.ctx.resume(); }
  get paused() { return this.ctx.state === 'suspended'; }
  /** song position in seconds, compensated for output latency */
  /** song time at which a DOM input event really happened (event.timeStamp, ms), minus the calibrated offset */
  timeAtEvent(eventTimeStamp?: number) {
    const lag = eventTimeStamp ? Math.max(0, Math.min(0.1, (performance.now() - eventTimeStamp) / 1000)) : 0;
    return this.time - lag - this.inputOffset;
  }
  get time() {
    if (!this.src) return 0;
    const lat = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    return this.offset + Math.max(0, this.ctx.currentTime - this.startCtx - Math.min(lat, 0.2));
  }
}

export interface ClockEvents {
  beat: (index: number, isDownbeat: boolean, time: number) => void;
  onset: (time: number, strength: number) => void;
  section: (s: Section, prev: Section | null) => void;
}

export class MusicClock {
  time = 0; beatIndex = -1; beatPhase = 0; bar = 0; energy = 0; brightness = 0;
  section: Section;
  private onsetCursor = 0; private listeners: { [K in keyof ClockEvents]: ClockEvents[K][] } = { beat: [], onset: [], section: [] };

  constructor(readonly player: SongPlayer, readonly an: Analysis, readonly st: Structure) { this.section = st.sections[0]; }

  on<K extends keyof ClockEvents>(k: K, fn: ClockEvents[K]) { this.listeners[k].push(fn); return this; }

  /** index of the last beat at or before t (-1 before the first beat) */
  beatAt(t: number) {
    const b = this.an.beats; let lo = 0, hi = b.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  /** signed distance (s) from t to the nearest beat */
  beatError(t: number) {
    const i = this.beatAt(t), b = this.an.beats;
    const a = i >= 0 ? t - b[i] : Infinity, c = i + 1 < b.length ? b[i + 1] - t : Infinity;
    return a <= c ? a : -c;
  }
  get period() { return this.st.beatPeriod; }

  /** call once per frame; fires events for everything crossed since the last update */
  update() {
    const t = this.player.time, b = this.an.beats;
    if (t < this.time - 0.5) { this.onsetCursor = 0; this.beatIndex = this.beatAt(t); } // seek/restart
    this.time = t;
    const bi = this.beatAt(t);
    while (this.beatIndex < bi) {
      this.beatIndex++;
      const down = ((this.beatIndex - this.an.downbeat) % 4 + 4) % 4 === 0;
      for (const fn of this.listeners.beat) fn(this.beatIndex, down, b[this.beatIndex]);
    }
    const p = this.period;
    this.beatPhase = bi >= 0 && bi + 1 < b.length ? (t - b[bi]) / (b[bi + 1] - b[bi]) : ((t - (b[0] ?? 0)) / p) % 1;
    this.bar = Math.floor((bi - this.an.downbeat) / 4);
    this.energy = sampleCurve(this.st.energy, this.st.rate, t);
    this.brightness = sampleCurve(this.st.brightness, this.st.rate, t);
    const so = this.st.strongOnsets;
    while (this.onsetCursor < so.length && so[this.onsetCursor].t <= t) { const o = so[this.onsetCursor++]; for (const fn of this.listeners.onset) fn(o.t, o.s); }
    const sec = sectionAt(this.st, t);
    if (sec !== this.section) { const prev = this.section; this.section = sec; for (const fn of this.listeners.section) fn(sec, prev); }
  }
}
