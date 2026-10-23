/** Generic "game feel" helpers: trauma-based screen shake, hit-stop, flash. Renderer-agnostic. */
export class Juice {
  private trauma = 0; private stopUntil = 0; private flashV = 0; private seed = Math.random() * 1000;
  /** add shake trauma (0..1); shake strength = trauma² */
  shake(amount: number) { this.trauma = Math.min(1, this.trauma + amount); }
  /** freeze gameplay time for `ms` (wall clock) — audio keeps running */
  hitStop(ms: number, now = performance.now()) { this.stopUntil = Math.max(this.stopUntil, now + ms); }
  flash(v = 1) { this.flashV = Math.max(this.flashV, v); }
  stopped(now = performance.now()) { return now < this.stopUntil; }
  /** call once per frame; returns camera offset (in units of maxOffset) + flash level */
  update(dt: number, maxOffset = 0.3, maxAngle = 0.03) {
    this.trauma = Math.max(0, this.trauma - dt * 1.6); this.flashV = Math.max(0, this.flashV - dt * 4);
    const s = this.trauma * this.trauma, k = (this.seed += dt * 37);
    const n = (o: number) => Math.sin(k * 1.7 + o) * 0.6 + Math.sin(k * 3.1 + o * 2.3) * 0.4;
    return { x: n(0) * s * maxOffset, y: n(11) * s * maxOffset, angle: n(23) * s * maxAngle, flash: this.flashV };
  }
}
