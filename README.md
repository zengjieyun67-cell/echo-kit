# echo-kit

**A zero-dependency TypeScript toolkit for music-driven and rhythm games in the browser (Web Audio).**
Load any song, find its beats and sections, keep gameplay locked to the music, and judge player input accurately. Works with any renderer: three.js, canvas, DOM, or Electron.

**零依赖的浏览器节奏游戏工具库（TypeScript + Web Audio）。**
读取任意歌曲，分析节拍和段落，让玩法和音乐严格同步，并准确判定玩家输入。可配合 three.js、Canvas、DOM 或 Electron 使用。

---

## Features / 功能

| Module | English | 中文 |
|---|---|---|
| `audio/analyze` | Decode any audio file; detect BPM, beats (dynamic-programming tracker), downbeat, onset envelope and band energies, fully in the browser | 解码任意音频，检测 BPM、节拍、强拍、起音包络和频段能量，全部在浏览器内完成 |
| `audio/structure` | Song sections (calm / build / peak / release), energy and brightness curves, strong onsets | 段落划分（平静/铺垫/高潮/回落）、能量与明暗曲线、强起音点 |
| `audio/clock` | `SongPlayer`: play/pause, latency-compensated song time, lowpass "restore" bus, SFX bus, `timeAtEvent()`, saved input offset. `MusicClock`: per-frame beat / bar / section / onset events | `SongPlayer`：播放暂停、补偿输出延迟的歌曲时间、低通「修复」总线、音效总线、按事件时间戳取歌曲时间、保存输入偏移。`MusicClock`：每帧触发拍、小节、段落、起音事件 |
| `engine/judge` | Timing grades (perfect / good / miss), nearest-target lookup, snapping, input buffer | 判定等级、最近目标查找、吸附、输入缓冲 |
| `engine/calibrate` | Tap-along metronome latency calibration (robust median) | 跟拍节拍器的延迟校准（抗异常值中位数） |
| `engine/juice` | Trauma-based screen shake, hit-stop, flash | 屏幕震动、顿帧、闪光 |
| `electron-template` | Minimal Electron main process (`app://` protocol so bundled audio loads) + after-pack script that stamps the Windows exe | 最小 Electron 主进程（`app://` 协议，打包后音频可正常加载）+ Windows exe 信息写入脚本 |

## Install / 安装

No npm package yet. Copy `src/` into your project, or add this repo as a git submodule:
暂未发布 npm 包。把 `src/` 复制进项目，或作为 git 子模块引入：

```bash
git submodule add https://github.com/zengjieyun67-cell/echo-kit.git lib/echo-kit
```

Requires a bundler that handles TypeScript (Vite, esbuild, etc.) and a browser with Web Audio.
需要支持 TypeScript 的打包工具（Vite、esbuild 等）和支持 Web Audio 的浏览器。

## Quick start / 快速上手

```ts
import { decodeFile, analyze, buildStructure, SongPlayer, MusicClock, grade } from './lib/echo-kit/src';

const player = new SongPlayer();                  // must start after a user gesture (browser autoplay rule)
const buffer = await decodeFile(file, player.ctx); // File or ArrayBuffer: mp3 / m4a / wav / ogg / flac
const an = await analyze(buffer, (p, label) => console.log(label, p));
const st = buildStructure(an);

const clock = new MusicClock(player, an, st)
  .on('beat', (i, isDownbeat) => { /* pulse the world */ })
  .on('section', (s, prev) => { /* change mood: s.kind = calm | build | peak | release */ })
  .on('onset', (t, strength) => { /* spawn something on strong hits */ });

await player.play(buffer);

addEventListener('keydown', e => {
  const t = player.timeAtEvent(e.timeStamp);     // real moment of the key press, in song seconds
  console.log(grade(clock.beatError(t)));        // 'perfect' | 'good' | 'miss'
});

(function frame() { clock.update(); requestAnimationFrame(frame); })();
```

### Latency calibration / 延迟校准

```ts
import { Calibrator } from './lib/echo-kit/src';
const cal = new Calibrator(player.ctx, 100, 16);  // 100 BPM, 16 clicks
cal.start();
addEventListener('keydown', e => cal.tap(e.timeStamp));
// after the clicks end:
const r = cal.result();                          // { offset, taps, spread } or null
if (r) player.setInputOffset(r.offset);          // saved in localStorage
```

### Game feel / 打击感

```ts
import { Juice } from './lib/echo-kit/src';
const juice = new Juice();
juice.shake(0.4); juice.hitStop(60); juice.flash(0.8);
const { x, y, angle, flash } = juice.update(dt);  // apply to camera / overlay each frame
```

## Notes / 说明

- Song time always comes from `AudioContext.currentTime`, never frame time, so gameplay stays in sync even when frames drop.
  歌曲时间始终来自 `AudioContext.currentTime`，不依赖帧时间，掉帧也不会失步。
- Analysis runs at 11 025 Hz mono; a 4-minute song takes about 1–3 s on a laptop.
  分析以 11025 Hz 单声道进行，4 分钟歌曲在笔记本上约 1–3 秒。
- Beat tracking follows D. P. W. Ellis, "Beat Tracking by Dynamic Programming" (2007).
  节拍追踪方法参考 Ellis (2007)。
- This toolkit contains no game content, levels, art, music or story. It was published as an open tool before thatgamejam #02 (Oct 24, 2026).
  本库不含任何游戏内容、关卡、美术、音乐或故事，于 thatgamejam #02（2026-10-24）开赛前作为公开工具发布。

## License / 协议

MIT © 2026 Jieyun Zeng
