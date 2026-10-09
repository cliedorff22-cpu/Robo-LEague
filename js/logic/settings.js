// settings.js - the game's settings: what they are, their defaults, and
// turning saved text back into a complete, valid set.
//
// Pure: the menus and the fight screen read and write the text (the browser
// keeps it in localStorage under SETTINGS_KEY); everything that USES a
// setting gets it handed in. Difficulty is the one the game logic reads -
// rules.json `difficulty` says what each level does, and a career copies the
// level onto itself whenever it changes, so it can be changed at any time.

export const SETTINGS_KEY = "robo-league.settings";

/** Every setting, in the order the settings pages show them. */
export const SETTINGS = [
  { id: "difficulty", group: "Gameplay", label: "Difficulty", type: "choice", default: "medium",
    options: [["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"], ["ultimate", "Ultimate"]],
    help: "How sharp the AI drivers are against you, how much they adapt and learn, and how much money you earn. Change it at any time." },
  { id: "advisor", group: "Gameplay", label: "Build advisor", type: "bool", default: true,
    help: "Show the optional build advisor in the workshop and the career hub." },
  { id: "replays", group: "Gameplay", label: "Highlight reel after the bell", type: "bool", default: true },
  { id: "camera", group: "Gameplay", label: "Starting camera", type: "choice", default: "chase",
    options: [["chase", "Chase"], ["overhead", "Overhead"], ["arena", "Arena cam"]] },
  { id: "bloom", group: "Graphics", label: "Bloom (sparks glow)", type: "bool", default: true },
  { id: "shadows", group: "Graphics", label: "Shadows", type: "bool", default: true },
  { id: "renderScale", group: "Graphics", label: "Render resolution", type: "choice", default: "1",
    options: [["0.5", "50% (fastest)"], ["0.75", "75%"], ["1", "100%"]] },
  { id: "hudDamage", group: "Display", label: "Damaged parts under the health bars", type: "bool", default: true },
  { id: "sound", group: "Sound", label: "Sound", type: "bool", default: true,
    help: "Motors, weapons, hits, hazards and the crowd. N mutes it in a fight." },
  { id: "volume", group: "Sound", label: "Volume", type: "choice", default: "0.75",
    options: [["0.25", "25%"], ["0.5", "50%"], ["0.75", "75%"], ["1", "100%"]] },
  { id: "crowd", group: "Sound", label: "Crowd", type: "choice", default: "1",
    options: [["0", "Off"], ["0.5", "Quiet"], ["1", "Normal"], ["1.5", "Loud"]] },
  { id: "commentary", group: "Sound", label: "Commentary", type: "choice", default: "both",
    options: [["off", "Off"], ["captions", "Captions"], ["voice", "Voice"], ["both", "Voice + captions"]],
    help: "Two commentators call the fight. The voice uses your computer's built-in speech; captions never name the arena's hazards." },
  { id: "steering", group: "Controls", label: "Steering sensitivity", type: "choice", default: "1",
    options: [["0.7", "Gentle"], ["1", "Normal"], ["1.3", "Sharp"]] },
];

export const DEFAULT_SETTINGS = Object.fromEntries(SETTINGS.map((s) => [s.id, s.default]));

/** A complete settings object from saved text (unknown keys dropped, bad values reset). */
export function readSettings(text) {
  let saved = {};
  try { saved = JSON.parse(text || "{}") || {}; } catch { saved = {}; }
  const out = { ...DEFAULT_SETTINGS };
  for (const s of SETTINGS) {
    const v = saved[s.id];
    if (v === undefined) continue;
    if (s.type === "bool" && typeof v === "boolean") out[s.id] = v;
    else if (s.type === "choice" && s.options.some(([k]) => k === String(v))) out[s.id] = String(v);
  }
  return out;
}

/** What a difficulty level does (rules.json `difficulty`), medium if unknown. */
export function difficultyOf(reg, level) {
  const d = reg.rules.difficulty || {};
  return { level: d[level] ? level : "medium", ...(d.medium || {}), ...(d[level] || {}) };
}
