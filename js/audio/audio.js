// audio.js - the fight's sound, synthesised with Web Audio: no sound files,
// the same way the textures are painted in code (materials.js).
//
// It listens to the same bus as the effects and the crowd (impacts, broken
// parts, hazards, the referee, the bell) and is told, once a frame, how fast
// each robot is driving and what its weapon is doing. Nothing in it touches
// game state, so a Godot port swaps this file for that engine's audio
// players and keeps the events.
//
// Browsers start audio only after a key press or click: unlock() is called
// from the first one.

import { EV } from "../core/bus.js";

const SEV = { scratch: 0, glance: 0.25, hit: 0.5, heavy: 0.8, catastrophic: 1 };

export function makeAudio({ bus = null, volume = 0.75, crowd = 1, enabled = true } = {}) {
  const AC = typeof AudioContext !== "undefined" ? AudioContext : typeof webkitAudioContext !== "undefined" ? webkitAudioContext : null;   // eslint-disable-line no-undef
  let ctx = null, master = null, sfx = null, crowdBus = null, noise = null, comp = null;
  let vol = volume, crowdVol = crowd, on = enabled;
  const voices = new Map();       // robot id -> its drive and weapon sounds
  const offs = [];
  let crowdBed = null, excitement = 0, alarm = null;

  function init() {
    if (ctx || !AC) return;
    ctx = new AC();
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = on ? vol : 0;
    master.connect(comp).connect(ctx.destination);
    sfx = ctx.createGain(); sfx.gain.value = 1; sfx.connect(master);
    crowdBus = ctx.createGain(); crowdBus.gain.value = crowdVol; crowdBus.connect(master);
    // Two seconds of white noise, reused by everything that hisses.
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    startCrowd();
  }

  const t0 = () => ctx.currentTime;
  const noiseSrc = (loop = false) => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = loop; if (loop) s.loopStart = Math.random(); return s; };
  const env = (g, at, peak, attack, decay) => {
    g.gain.cancelScheduledValues(at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  };
  const panner = (pan) => { if (!ctx.createStereoPanner) return ctx.createGain(); const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0)); return p; };

  // ---------------------------------------------------------------- one-shots

  /** Steel on steel: a thump, a crack of noise and a few inharmonic rings. */
  function impact({ strength = 0.5, kind = "weapon", pan = 0, dist = 0.5 } = {}) {
    if (!ctx) return;
    const at = t0();
    const near = 1 - Math.min(0.75, dist * 0.6);
    const out = panner(pan); out.connect(sfx);
    // Thump.
    const o = ctx.createOscillator(); const og = ctx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(kind === "ram" ? 70 : 110, at); o.frequency.exponentialRampToValueAtTime(38, at + 0.25);
    env(og, at, 0.9 * strength * near, 0.004, 0.28 + strength * 0.2);
    o.connect(og).connect(out); o.start(at); o.stop(at + 0.6);
    // Crack.
    const n = noiseSrc(); const bp = ctx.createBiquadFilter(); const ng = ctx.createGain();
    bp.type = "bandpass"; bp.frequency.value = kind === "ram" ? 900 : 2600 + Math.random() * 1500; bp.Q.value = 0.8;
    env(ng, at, 0.7 * strength * near, 0.002, 0.08 + strength * 0.18);
    n.connect(bp).connect(ng).connect(out); n.start(at); n.stop(at + 0.5);
    // Ring: a weapon hit rings like struck plate.
    if (kind !== "ram") {
      const base = 300 + Math.random() * 220;
      for (const [mult, amp] of [[1, 0.22], [2.76, 0.14], [5.4, 0.09], [8.9, 0.05]]) {
        const r = ctx.createOscillator(); const rg = ctx.createGain();
        r.type = "sine"; r.frequency.value = base * mult;
        env(rg, at, amp * strength * near, 0.002, 0.25 + strength * 0.7);
        r.connect(rg).connect(out); r.start(at); r.stop(at + 1.2);
      }
    }
  }

  /** A part giving way: a heavier crunch, and a fire's whoomph for a battery. */
  function breakSound(category, pan) {
    if (!ctx) return;
    impact({ strength: 0.9, kind: "weapon", pan, dist: 0.3 });
    const at = t0();
    const n = noiseSrc(); const lp = ctx.createBiquadFilter(); const g = ctx.createGain();
    lp.type = "lowpass"; lp.frequency.setValueAtTime(category === "battery" ? 600 : 3000, at); lp.frequency.exponentialRampToValueAtTime(200, at + 0.6);
    env(g, at, category === "battery" ? 0.8 : 0.45, 0.01, category === "battery" ? 1.2 : 0.5);
    const out = panner(pan); out.connect(sfx);
    n.connect(lp).connect(g).connect(out); n.start(at); n.stop(at + 1.5);
  }

  /** The arena's hazards. */
  function hazard(type) {
    if (!ctx) return;
    const at = t0();
    if (type === "pulverizer" || type === "hammer") {
      // A pneumatic hiss, then the hammer landing.
      const n = noiseSrc(); const hp = ctx.createBiquadFilter(); const g = ctx.createGain();
      hp.type = "highpass"; hp.frequency.value = 2500;
      env(g, at, 0.25, 0.01, 0.35);
      n.connect(hp).connect(g).connect(sfx); n.start(at); n.stop(at + 0.5);
      setTimeout(() => impact({ strength: 1, kind: "ram", dist: 0.3 }), 260);
    } else if (type === "killsaw") {
      const o = ctx.createOscillator(); const g = ctx.createGain(); const f = ctx.createBiquadFilter();
      o.type = "sawtooth"; o.frequency.setValueAtTime(120, at); o.frequency.exponentialRampToValueAtTime(900, at + 0.7);
      f.type = "bandpass"; f.frequency.value = 1500; f.Q.value = 1.5;
      env(g, at, 0.18, 0.05, 1.1);
      o.connect(f).connect(g).connect(sfx); o.start(at); o.stop(at + 1.3);
    } else if (type === "pit") {
      // A deep rumble as the floor goes.
      const n = noiseSrc(); const lp = ctx.createBiquadFilter(); const g = ctx.createGain();
      lp.type = "lowpass"; lp.frequency.value = 160;
      env(g, at, 1.0, 0.2, 2.5);
      n.connect(lp).connect(g).connect(sfx); n.start(at); n.stop(at + 3);
      const o = ctx.createOscillator(); const og = ctx.createGain();
      o.frequency.setValueAtTime(55, at); o.frequency.linearRampToValueAtTime(35, at + 2.5);
      env(og, at, 0.5, 0.2, 2.4);
      o.connect(og).connect(sfx); o.start(at); o.stop(at + 3);
    } else if (type === "screw") {
      grind(0.4);
    }
  }

  function grind(strength) {
    const at = t0();
    const n = noiseSrc(); const bp = ctx.createBiquadFilter(); const g = ctx.createGain();
    bp.type = "bandpass"; bp.frequency.value = 450; bp.Q.value = 3;
    const lfo = ctx.createOscillator(); const lg = ctx.createGain();
    lfo.frequency.value = 28; lg.gain.value = 0.15 * strength;
    lfo.connect(lg).connect(g.gain);
    env(g, at, 0.3 * strength, 0.02, 0.6);
    n.connect(bp).connect(g).connect(sfx); n.start(at); n.stop(at + 0.8); lfo.start(at); lfo.stop(at + 0.8);
  }

  /** The bell (and the start horn): struck metal partials, or a horn. */
  function bell() {
    if (!ctx) return;
    const at = t0();
    for (let k = 0; k < 3; k++) {
      for (const [f, a] of [[880, 0.25], [2350, 0.12], [3900, 0.06]]) {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = f; env(g, at + k * 0.32, a, 0.003, 0.9);
        o.connect(g).connect(sfx); o.start(at + k * 0.32); o.stop(at + k * 0.32 + 1);
      }
    }
  }
  function horn(len = 0.9) {
    if (!ctx) return;
    const at = t0();
    for (const f of [233, 277, 349]) {
      const o = ctx.createOscillator(); const g = ctx.createGain(); const lp = ctx.createBiquadFilter();
      o.type = "sawtooth"; o.frequency.value = f; lp.type = "lowpass"; lp.frequency.value = 1800;
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.12, at + 0.03);
      g.gain.setValueAtTime(0.12, at + len); g.gain.exponentialRampToValueAtTime(0.0001, at + len + 0.15);
      o.connect(lp).connect(g).connect(sfx); o.start(at); o.stop(at + len + 0.2);
    }
  }
  function beep(f = 880, len = 0.12, amp = 0.15) {
    if (!ctx) return;
    const at = t0();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "square"; o.frequency.value = f;
    g.gain.setValueAtTime(amp, at); g.gain.setValueAtTime(0.0001, at + len);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3000;
    o.connect(lp).connect(g).connect(sfx); o.start(at); o.stop(at + len + 0.02);
  }

  // ---------------------------------------------------------------- the crowd
  function startCrowd() {
    // A bed of murmur: two bands of noise, slowly breathing.
    const mk = (freq, q) => {
      const n = noiseSrc(true); const bp = ctx.createBiquadFilter(); const g = ctx.createGain();
      bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = q;
      g.gain.value = 0.0001;
      n.connect(bp).connect(g).connect(crowdBus); n.start();
      return { g, bp };
    };
    crowdBed = { low: mk(420, 0.7), high: mk(1300, 0.9), voice: mk(700, 4) };
  }
  /** Lift the crowd: 0.3 a murmur of interest, 1 on their feet. */
  function cheer(level = 0.6) {
    excitement = Math.min(1.6, Math.max(excitement, level));
    if (!ctx || level < 0.8) return;
    // An "ooh": a formant sweeping up through the voice band.
    const at = t0();
    crowdBed.voice.bp.frequency.cancelScheduledValues(at);
    crowdBed.voice.bp.frequency.setValueAtTime(450, at);
    crowdBed.voice.bp.frequency.exponentialRampToValueAtTime(950, at + 0.6);
    crowdBed.voice.bp.frequency.exponentialRampToValueAtTime(650, at + 1.6);
  }

  // ---------------------------------------------------------------- per-robot sounds
  /** A robot's drive whine and its weapon, created on first use. */
  function voiceOf(id, family) {
    if (voices.has(id)) return voices.get(id);
    const out = panner(0); out.connect(sfx);
    // Drive: two detuned saws through a lowpass (brushless motors and gearboxes).
    const d1 = ctx.createOscillator(), d2 = ctx.createOscillator(), dlp = ctx.createBiquadFilter(), dg = ctx.createGain();
    d1.type = "sawtooth"; d2.type = "square"; dlp.type = "lowpass"; dlp.frequency.value = 600; dg.gain.value = 0.0001;
    d1.connect(dlp); d2.connect(dlp); dlp.connect(dg).connect(out); d1.start(); d2.start();
    const v = { out, d1, d2, dlp, dg, family };
    if (family === "kinetic") {
      // A spinner: a rising whine and the whoosh of the blade going past.
      const w = ctx.createOscillator(), wg = ctx.createGain(), wf = ctx.createBiquadFilter();
      w.type = "triangle"; wf.type = "bandpass"; wf.Q.value = 2; wg.gain.value = 0.0001;
      w.connect(wf).connect(wg).connect(out); w.start();
      const n = noiseSrc(true), nf = ctx.createBiquadFilter(), ng = ctx.createGain(), am = ctx.createGain();
      nf.type = "bandpass"; nf.frequency.value = 900; nf.Q.value = 0.7; ng.gain.value = 0.0001; am.gain.value = 0.5;
      const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfo.type = "sine"; lfoG.gain.value = 0.5;
      lfo.connect(lfoG).connect(am.gain);
      n.connect(nf).connect(am).connect(ng).connect(out); n.start(); lfo.start();
      Object.assign(v, { w, wg, wf, ng, lfo });
    }
    voices.set(id, v);
    return v;
  }

  function pneumatic(pan) {
    if (!ctx) return;
    const at = t0();
    const n = noiseSrc(); const hp = ctx.createBiquadFilter(); const g = ctx.createGain();
    hp.type = "bandpass"; hp.frequency.value = 3000; hp.Q.value = 0.5;
    env(g, at, 0.35, 0.005, 0.3);
    const out = panner(pan); out.connect(sfx);
    n.connect(hp).connect(g).connect(out); n.start(at); n.stop(at + 0.4);
    impact({ strength: 0.35, kind: "ram", pan, dist: 0.5 });
  }

  // ---------------------------------------------------------------- the bus
  if (bus) {
    offs.push(bus.on(EV.HIT, (e) => {
      const s = SEV[e.severity] ?? 0.3;
      if (s <= 0) return;
      impact({ strength: Math.min(1, 0.25 + s * 0.8), kind: e.kind === "ram" ? "ram" : "weapon", pan: e.pan ?? 0, dist: 0.4 });
      if (e.kind === "hazard" && e.hazardType === "screw") grind(0.8);
      if (s >= 0.8) cheer(s >= 1 ? 1.2 : 0.9);
      else if (s >= 0.5) cheer(0.5);
    }));
    offs.push(bus.on(EV.PART_FAILED, (e) => { breakSound(e.category, 0); cheer(0.9); }));
    offs.push(bus.on(EV.HAZARD_FIRE, (e) => hazard(e.type)));
    offs.push(bus.on(EV.REF_COUNT, ({ count, of }) => { beep(count >= of - 2 ? 1320 : 990, 0.09, 0.1); if (count === 1) cheer(0.6); }));
    offs.push(bus.on(EV.KO, () => cheer(1.5)));
    offs.push(bus.on(EV.TAP_OUT, () => cheer(1.0)));
    offs.push(bus.on(EV.PIN_WARNING, () => beep(520, 0.25, 0.1)));
    offs.push(bus.on(EV.MATCH_END, () => { bell(); cheer(1.3); }));
  }

  return {
    get ready() { return !!ctx; },
    /** First key press or click: start the audio (browsers insist). */
    unlock() { init(); if (ctx?.state === "suspended") ctx.resume(); },
    setVolume(v) { vol = v; if (master) master.gain.setTargetAtTime(on ? vol : 0, t0(), 0.05); },
    setCrowd(v) { crowdVol = v; if (crowdBus) crowdBus.gain.setTargetAtTime(v, t0(), 0.1); },
    setEnabled(b) { on = b; if (master) master.gain.setTargetAtTime(on ? vol : 0, t0(), 0.05); },
    get enabled() { return on; },
    toggle() { this.setEnabled(!on); return on; },

    // One-shots the fight screen calls directly.
    countdownBeep(n) { beep(n > 0 ? 660 : 1320, n > 0 ? 0.14 : 0.35, 0.14); },
    startHorn() { horn(0.8); cheer(1.0); },
    bell, beep, impact, cheer,
    weaponFired(pan = 0) { pneumatic(pan); },

    /**
     * Once a frame. `bots`: [{ id, speed 0..1, throttle 0..1, family, spin 0..1,
     * omega rad/s, pan -1..1, dist 0..1 (0 = at the camera) }]; `live`: the
     * match is running; `pitWarning`: 0..1 while the pit is about to open.
     */
    update(dt, { bots = [], live = false, pitWarning = 0, energy = 0.4 } = {}) {
      if (!ctx) return;
      const now = t0();
      for (const b of bots) {
        const v = voiceOf(b.id, b.family);
        const near = 1 - Math.min(0.85, (b.dist ?? 0.5) * 0.7);
        if (v.out.pan) v.out.pan.setTargetAtTime(Math.max(-1, Math.min(1, b.pan || 0)), now, 0.05);
        // Drive whine climbs with speed; louder when the driver is on it.
        const f = 55 + b.speed * 260;
        v.d1.frequency.setTargetAtTime(f, now, 0.05);
        v.d2.frequency.setTargetAtTime(f * 1.503, now, 0.05);
        v.dlp.frequency.setTargetAtTime(300 + b.speed * 1400, now, 0.08);
        v.dg.gain.setTargetAtTime(b.out ? 0.0001 : (0.012 + b.throttle * 0.045 + b.speed * 0.03) * near, now, 0.06);
        if (v.w) {
          const s = Math.max(0, Math.min(1, b.spin || 0));
          v.w.frequency.setTargetAtTime(80 + s * 620, now, 0.08);
          v.wf.frequency.setTargetAtTime(160 + s * 1500, now, 0.08);
          v.wg.gain.setTargetAtTime(s > 0.02 ? (0.03 + s * 0.08) * near : 0.0001, now, 0.1);
          // Whoosh: the blades passing, as fast as the ear can follow.
          v.lfo.frequency.setTargetAtTime(Math.min(45, 4 + (b.omega || 0) * 0.12), now, 0.1);
          v.ng.gain.setTargetAtTime(s > 0.05 ? s * 0.12 * near : 0.0001, now, 0.1);
        }
      }
      // The crowd: a bed that rises with the action and settles back.
      excitement = Math.max(0, excitement - dt * 0.35);
      const base = (live ? 0.05 + energy * 0.07 : 0.03 + energy * 0.04);
      const lift = excitement * 0.32;
      if (crowdBed) {
        crowdBed.low.g.gain.setTargetAtTime(base + lift * 0.6, now, 0.25);
        crowdBed.high.g.gain.setTargetAtTime(base * 0.6 + lift, now, 0.2);
        crowdBed.voice.g.gain.setTargetAtTime(lift * 0.5, now, 0.15);
      }
      // The pit's alarm: a slow two-tone while its lamps flash.
      if (pitWarning > 0 && live) {
        alarm = (alarm || 0) - dt;
        if (alarm <= 0) { beep(Math.floor(now * 2.5) % 2 ? 740 : 560, 0.28, 0.09); alarm = 0.4; }
      } else alarm = 0;
    },

    /** Robots that have gone quiet (out of the fight) can be muted by id. */
    silence(id) { const v = voices.get(id); if (v && ctx) { v.dg.gain.setTargetAtTime(0.0001, t0(), 0.1); v.wg?.gain.setTargetAtTime(0.0001, t0(), 0.1); v.ng?.gain.setTargetAtTime(0.0001, t0(), 0.1); } },

    dispose() { for (const o of offs) o(); ctx?.close(); },
  };
}
