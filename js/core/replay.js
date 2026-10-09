// replay.js - a fixed-size ring buffer of poses, for instant replays.
//
// Records only transforms, not physics state, so playback is a camera trick
// rather than a re-simulation. That keeps it cheap and makes it trivially
// portable. Stage 2 will tag frames with big-hit events so replays can
// auto-trigger on a heavy impact.

export function makeReplay({ seconds = 12, hz = 30, trackCount = 1 } = {}) {
  const capacity = Math.ceil(seconds * hz);
  const interval = 1 / hz;

  // Flat preallocated arrays: 7 floats per tracked object (pos xyz + quat xyzw).
  const stride = trackCount * 7;
  const frames = new Float32Array(capacity * stride);
  const times = new Float32Array(capacity);

  let head = 0;        // next slot to write
  let count = 0;       // frames recorded, capped at capacity
  let acc = 0;         // time since the last sample

  let playing = false;
  let playT = 0;
  let playFrom = 0;    // index of the oldest frame in the playback window
  let playLen = 0;
  // What playback reads from: the live ring, or a captured clip.
  let src = { buf: frames, cap: capacity };

  return {
    get recording() { return !playing; },
    get playing() { return playing; },
    get frameCount() { return count; },
    get capacity() { return capacity; },

    /** Call every frame with the live poses while the match runs. */
    record(dt, poses, tNow) {
      if (playing) return;
      acc += dt;
      if (acc < interval) return;
      acc -= interval;

      const base = head * stride;
      for (let i = 0; i < trackCount; i++) {
        const p = poses[i];
        const o = base + i * 7;
        if (!p) { frames[o + 6] = 1; continue; }
        frames[o]     = p.pos.x;
        frames[o + 1] = p.pos.y;
        frames[o + 2] = p.pos.z;
        frames[o + 3] = p.quat.x;
        frames[o + 4] = p.quat.y;
        frames[o + 5] = p.quat.z;
        frames[o + 6] = p.quat.w;
      }
      times[head] = tNow;
      head = (head + 1) % capacity;
      if (count < capacity) count++;
    },

    /** Start playing back the last `seconds` of recording. */
    play(seconds = 6) {
      const want = Math.min(count, Math.ceil(seconds * hz));
      if (want < 2) return false;
      playLen = want;
      playFrom = (head - want + capacity) % capacity;
      src = { buf: frames, cap: capacity };
      playT = 0;
      playing = true;
      return true;
    },

    /**
     * Copy the last `seconds` out of the ring into a standalone clip, so a
     * moment survives after the ring has recorded over it - the hit of the
     * match, shown on the results screen.
     */
    capture(seconds = 5) {
      const len = Math.min(count, Math.ceil(seconds * hz));
      if (len < 2) return null;
      const out = new Float32Array(len * stride);
      const from = (head - len + capacity) % capacity;
      for (let i = 0; i < len; i++) {
        const k = (from + i) % capacity;
        out.set(frames.subarray(k * stride, (k + 1) * stride), i * stride);
      }
      return { frames: out, len };
    },

    /** Play a clip from capture(). */
    playClip(clip) {
      if (!clip || clip.len < 2) return false;
      src = { buf: clip.frames, cap: clip.len };
      playFrom = 0;
      playLen = clip.len;
      playT = 0;
      playing = true;
      return true;
    },

    stop() { playing = false; },

    /**
     * Advance playback. Returns an array of interpolated poses, or null when
     * the replay has finished.
     */
    sample(dt, speed = 0.5) {
      if (!playing) return null;
      playT += dt * speed;
      const f = playT / interval;
      if (f >= playLen - 1) { playing = false; return null; }

      const i0 = Math.floor(f);
      const t = f - i0;
      const a = (playFrom + i0) % src.cap;
      const b = (playFrom + i0 + 1) % src.cap;
      const frames = src.buf;

      const out = [];
      for (let i = 0; i < trackCount; i++) {
        const oa = a * stride + i * 7;
        const ob = b * stride + i * 7;
        out.push({
          pos: {
            x: lerp(frames[oa], frames[ob], t),
            y: lerp(frames[oa + 1], frames[ob + 1], t),
            z: lerp(frames[oa + 2], frames[ob + 2], t),
          },
          quat: slerp(
            frames[oa + 3], frames[oa + 4], frames[oa + 5], frames[oa + 6],
            frames[ob + 3], frames[ob + 4], frames[ob + 5], frames[ob + 6],
            t
          ),
        });
      }
      return out;
    },

    /** Progress through the current replay, 0..1 - for the HUD scrub bar. */
    progress() {
      if (!playing || playLen < 2) return 0;
      return Math.min(1, (playT / interval) / (playLen - 1));
    },

    clear() { head = 0; count = 0; acc = 0; playing = false; },
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest-arc quaternion interpolation, falling back to nlerp when close. */
function slerp(ax, ay, az, aw, bx, by, bz, bw, t) {
  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }

  let s0 = 1 - t, s1 = t;
  if (d < 0.9995) {
    const theta = Math.acos(Math.min(1, d));
    const sin = Math.sin(theta);
    if (sin > 1e-6) {
      s0 = Math.sin((1 - t) * theta) / sin;
      s1 = Math.sin(t * theta) / sin;
    }
  }

  const x = ax * s0 + bx * s1, y = ay * s0 + by * s1;
  const z = az * s0 + bz * s1, w = aw * s0 + bw * s1;
  const l = Math.hypot(x, y, z, w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}
