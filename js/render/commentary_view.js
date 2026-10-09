// commentary_view.js - the commentary booth on screen and out loud.
//
// Takes the lines js/logic/commentary.js writes and plays them one at a time:
// spoken (js/audio/speech.js) and/or as a caption bar at the foot of the
// screen, depending on the Commentary setting. A knockout interrupts chatter;
// chatter that has waited too long is dropped rather than said late. Lines
// about the arena's hazards are spoken only - never captioned.

export const BOOTH = { pbp: "Rex Gearhart", color: "Dottie Volt" };
const STALE_S = 4;

export function makeCommentaryView(root, { speech, mode = "both" } = {}) {
  root.innerHTML = `<div class="booth" id="booth"><span class="booth-who" id="booth-who"></span><span class="booth-text" id="booth-text"></span></div>`;
  const $box = root.querySelector("#booth"), $who = root.querySelector("#booth-who"), $text = root.querySelector("#booth-text");
  let queue = [], current = null, showT = 0, now = 0, gen = 0;
  const voiceOn = () => (mode === "voice" || mode === "both") && speech?.available;
  const captionsOn = () => mode === "captions" || mode === "both";

  function next() {
    current = null;
    queue = queue.filter((l) => l.pri >= 3 || now - l.at < STALE_S);
    if (!queue.length) { if (showT <= 0) $box.classList.remove("show"); return; }
    // In the order the booth said them, except that must-say lines jump the queue.
    const i = Math.max(0, queue.findIndex((l) => l.pri >= 3));
    play(queue.splice(i, 1)[0]);
  }

  function play(l) {
    current = l;
    const my = ++gen;
    if (captionsOn() && !l.hazard) {
      $who.textContent = BOOTH[l.who] || "";
      $who.className = `booth-who ${l.who}`;
      $text.textContent = l.text;
      $box.classList.add("show");
      showT = 1.6 + l.text.length * 0.055;
    }
    const spoken = voiceOn() && speech.unlocked && speech.say(l, () => { if (my === gen) next(); });
    if (!spoken) {
      // Captions only (or a hazard line with no voice): pace by reading time.
      l.until = now + (captionsOn() && !l.hazard ? 1.4 + l.text.length * 0.05 : 0);
    }
  }

  return {
    /** Lines from commentary.js. */
    push(lines) {
      if (mode === "off") return;
      for (const l of lines || []) {
        if (!voiceOn() && l.hazard) continue;
        const item = { ...l, at: now };
        if (l.pri >= 3 && current && current.pri < 3) {
          // Cut the chatter off for the big moment.
          speech?.cancel();
          queue = queue.filter((x) => x.pri >= 2);
          queue.unshift(item);
          gen++;
          next();
          continue;
        }
        if (l.pri === 0 && (current || queue.length)) continue;     // chatter only into silence
        if (queue.length >= 3) { const low = queue.reduce((m, x) => (x.pri < m.pri ? x : m)); if (low.pri < l.pri) queue.splice(queue.indexOf(low), 1); else continue; }
        queue.push(item);
      }
      if (!current) next();
    },

    update(dt) {
      now += dt;
      if (showT > 0) { showT -= dt; if (showT <= 0 && !current) $box.classList.remove("show"); }
      if (current && current.until !== undefined && now >= current.until) next();
      if (showT <= 0 && current && !captionsOn()) $box.classList.remove("show");
      if (showT <= 0 && !current) $box.classList.remove("show");
    },

    setMode(m) { mode = m; if (m === "off") this.clear(); if (!captionsOn()) $box.classList.remove("show"); },

    clear() { queue = []; current = null; gen++; speech?.cancel(); $box.classList.remove("show"); showT = 0; },
  };
}
