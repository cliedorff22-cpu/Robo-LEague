// speech.js - the commentators' voices, from the browser's own speech
// synthesis (no audio files, no network). Two voices: play-by-play is
// quicker and higher, colour slower and lower; if the computer has more than
// one English voice they get different ones.
//
// Browsers only let a page speak after the player has pressed a key or
// clicked, so nothing is said until then (unlock()).

export function makeSpeech() {
  const synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
  let voices = [], unlocked = false, volume = 1;
  // macOS ships joke voices (Bubbles, Zarvox...) alongside the real ones.
  const NOVELTY = /Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Kathy|Fred|Grandma|Grandpa|Rocko|Shelley|Sandy|Flo|Eddy|Reed/;
  const PBP = ["Daniel", "Alex", "Google UK English Male", "Microsoft Guy", "Microsoft David", "Arthur", "Oliver", "Tom"];
  const COLOR = ["Samantha", "Karen", "Moira", "Tessa", "Google US English", "Microsoft Aria", "Microsoft Zira", "Serena", "Allison"];
  let chosen = { pbp: null, color: null };
  const pickVoices = () => {
    if (!synth) return;
    voices = synth.getVoices().filter((v) => /^en/i.test(v.lang) && !NOVELTY.test(v.name));
    const find = (names, not) => { for (const n of names) { const v = voices.find((x) => x.name.startsWith(n) && x !== not); if (v) return v; } return voices.find((x) => x !== not) || null; };
    chosen.pbp = find(PBP, null);
    chosen.color = find(COLOR, chosen.pbp);
  };
  pickVoices();
  synth?.addEventListener?.("voiceschanged", pickVoices);

  const voiceFor = (who) => (who === "color" ? chosen.color : chosen.pbp) || null;

  return {
    get available() { return !!synth; },
    get unlocked() { return unlocked; },
    unlock() { unlocked = true; },
    setVolume(v) { volume = Math.max(0, Math.min(1, v)); },
    get speaking() { return !!synth?.speaking; },

    /** Say a line; `done` is called when it finishes (or fails). */
    say(line, done = () => {}) {
      if (!synth || !unlocked || volume <= 0) { done(); return false; }
      const u = new SpeechSynthesisUtterance(line.text.replace(/[!?]{2,}/g, "!"));
      const v = voiceFor(line.who);
      if (v) u.voice = v;
      const excited = line.pri >= 3 || /!/.test(line.text);
      u.rate = line.who === "color" ? 1.02 : excited ? 1.22 : 1.12;
      u.pitch = line.who === "color" ? 0.82 : excited ? 1.15 : 1.0;
      u.volume = volume;
      let finished = false;
      const fin = () => { if (!finished) { finished = true; done(); } };
      u.onend = fin; u.onerror = fin;
      synth.speak(u);
      // Some engines never fire onend: don't let the booth hang.
      setTimeout(fin, 900 + line.text.length * 95);
      return true;
    },

    cancel() { synth?.cancel(); },
  };
}
