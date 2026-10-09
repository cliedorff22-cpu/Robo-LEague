// savefile.js - save export and import: everything the game keeps on this
// computer, in one file you can back up or carry to another computer. No
// cloud, no account - a plain JSON file.
//
//   { schema: "robo-league-backup/1", game, savedAt,
//     career, hall, tournament, settings }    each one optional
//
// Every part is checked on the way in by its own loader (career.js
// deserialize migrates an old career, cup.js and halloffame.js check theirs),
// so a backup from an older version of the game loads into this one. A bare
// career save (what localStorage holds) imports too.
//
// Pure: strings and objects in and out. js/menu/saves_ui.js does the
// downloading, the file picking and localStorage.

import { deserialize, serialize, CAREER_SCHEMA } from "./career.js";
import { deserializeCup, serializeCup, CUP_SCHEMA } from "./cup.js";
import { HOF_SCHEMA } from "./halloffame.js";
import { readSettings } from "./settings.js";

export const BACKUP_SCHEMA = "robo-league-backup/1";

/**
 * A backup of what is passed (any of them may be null).
 * @param parts  { career, hall, tournament, settings } - objects, as the game keeps them
 * @returns the file's text
 */
export function makeBackup({ career = null, hall = null, tournament = null, settings = null } = {}, savedAt = new Date().toISOString()) {
  const out = { schema: BACKUP_SCHEMA, game: "ROBO LEAGUE", savedAt };
  if (career) out.career = JSON.parse(serialize(career));
  if (hall && (hall.careers?.length || hall.legends?.length)) out.hall = hall;
  if (tournament) out.tournament = JSON.parse(serializeCup(tournament));
  if (settings) out.settings = settings;
  return JSON.stringify(out);
}

/**
 * Read a backup (or a bare career save). Throws with a plain reason if it is
 * not one, or is from a newer version of the game.
 * @returns { career, hall, tournament, settings, savedAt } - each checked and
 *   migrated, or null if the file had none
 */
export function readBackup(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error("That file is not a ROBO LEAGUE save: it is not JSON."); }
  if (!raw || typeof raw !== "object") throw new Error("That file is not a ROBO LEAGUE save.");
  // A bare career save.
  if (raw.schema === CAREER_SCHEMA) return { career: deserialize(text), hall: null, tournament: null, settings: null, savedAt: null };
  if (raw.schema !== BACKUP_SCHEMA) {
    if (typeof raw.schema === "string" && raw.schema.startsWith("robo-league-backup/")) throw new Error(`That backup is from a newer version of the game (${raw.schema}).`);
    throw new Error("That file is not a ROBO LEAGUE save.");
  }
  const out = { career: null, hall: null, tournament: null, settings: null, savedAt: raw.savedAt || null };
  if (raw.career) out.career = deserialize(JSON.stringify(raw.career));
  if (raw.hall) {
    if (raw.hall.schema !== HOF_SCHEMA) throw new Error("The Hall of Fame in that file is not one this game can read.");
    out.hall = raw.hall;
  }
  if (raw.tournament) {
    if (raw.tournament.schema !== CUP_SCHEMA) throw new Error("The tournament in that file is not one this game can read.");
    out.tournament = deserializeCup(JSON.stringify(raw.tournament));
  }
  if (raw.settings) out.settings = readSettings(JSON.stringify(raw.settings));
  if (!out.career && !out.hall && !out.tournament && !out.settings) throw new Error("That save file is empty.");
  return out;
}

/** One line on what a backup holds, for the import's "are you sure". */
export function describeBackup(b, nameOf = (c) => c.garage?.name || "your robot") {
  const bits = [];
  if (b.career) {
    const c = b.career;
    bits.push(`the career of ${c.team} - season ${c.seasonIndex}, ${nameOf(c)}, ${c.stats?.wins ?? 0}-${c.stats?.losses ?? 0}, $${Math.round(c.cash).toLocaleString()}`);
  }
  if (b.hall) bits.push(`a Hall of Fame of ${b.hall.careers?.length ?? 0} career${b.hall.careers?.length === 1 ? "" : "s"}`);
  if (b.tournament) bits.push(`the tournament "${b.tournament.name}"${b.tournament.done ? " (finished)" : ""}`);
  if (b.settings) bits.push("your settings");
  return bits;
}

/** A file name for a backup: robo-league-<team>-s<season>-<date>.json */
export function backupFileName(career, date = new Date()) {
  const team = String(career?.team || "backup").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "backup";
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `robo-league-${team}${career ? `-s${career.seasonIndex}` : ""}-${d}.json`;
}
