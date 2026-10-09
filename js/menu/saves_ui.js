// saves_ui.js - export and import, the browser half: what is saved on this
// computer (localStorage), downloading a backup file, picking one to load.
// What a backup is and how it is checked is js/logic/savefile.js.

import { makeBackup, readBackup, describeBackup, backupFileName } from "../logic/savefile.js";
import { deserialize } from "../logic/career.js";
import { deserializeCup } from "../logic/cup.js";
import { loadHall } from "../logic/halloffame.js";
import { loadSettings, settingsKey } from "./settings_ui.js";

export const KEYS = { career: "robo-league.career", hall: "robo-league.halloffame", tournament: "robo-league.tournament", get settings() { return settingsKey(); } };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** What is saved on this computer now, as the game keeps it. */
export function savedHere() {
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  let career = null, tournament = null;
  try { career = get(KEYS.career) ? deserialize(get(KEYS.career)) : null; } catch { career = null; }
  try { tournament = get(KEYS.tournament) ? deserializeCup(get(KEYS.tournament)) : null; } catch { tournament = null; }
  const hall = loadHall(get(KEYS.hall));
  return { career, tournament, hall: hall.careers.length || hall.legends.length ? hall : null, settings: loadSettings() };
}

/** The backup file's text and name for what is saved here (or only `parts`). */
export function exportText(only = null) {
  const here = savedHere();
  const parts = only ? Object.fromEntries(only.map((k) => [k, here[k]])) : here;
  return { text: makeBackup(parts), name: backupFileName(parts.career) };
}

/** Hand the browser a file to save. */
export function download(name, text) {
  if (typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return false;
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

/** Ask for a file and read it as text. Resolves null if nothing was picked. */
export function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      f.text().then(resolve, () => resolve(null));
    });
    input.click();
  });
}

/**
 * Load a backup's text into this computer, replacing what it holds of the
 * same kind. Asks first (unless `ask` is false).
 * @returns { ok, reason, loaded: [kind] }
 */
export function importText(text, { ask = true } = {}) {
  let b;
  try { b = readBackup(text); } catch (e) { return { ok: false, reason: String(e.message || e), loaded: [] }; }
  const what = describeBackup(b);
  const here = savedHere();
  const replacing = [b.career && here.career && "your career here", b.hall && here.hall && "the Hall of Fame here", b.tournament && here.tournament && "the tournament here"].filter(Boolean);
  if (ask && !confirm(`Load ${what.join("; ")}?${replacing.length ? `\n\nThis replaces ${replacing.join(" and ")}. Export first if you want to keep it.` : ""}`)) {
    return { ok: false, reason: "Cancelled.", loaded: [] };
  }
  const loaded = [];
  try {
    if (b.career) { localStorage.setItem(KEYS.career, JSON.stringify(b.career)); loaded.push("career"); }
    if (b.hall) { localStorage.setItem(KEYS.hall, JSON.stringify(b.hall)); loaded.push("hall"); }
    if (b.tournament) { localStorage.setItem(KEYS.tournament, JSON.stringify(b.tournament)); loaded.push("tournament"); }
    if (b.settings) { localStorage.setItem(KEYS.settings, JSON.stringify(b.settings)); loaded.push("settings"); }
  } catch (e) { return { ok: false, reason: `This browser would not save it: ${e.message || e}`, loaded }; }
  // A career hand-off from another computer means nothing here.
  for (const k of ["robo-league.career.fight", "robo-league.career.result", "robo-league.tournament.fight", "robo-league.tournament.result"]) localStorage.removeItem(k);
  return { ok: true, reason: "", loaded, what };
}

/**
 * The Saves panel (main menu Settings, the career's Settings tab): what is
 * saved here, Export, Import. `onImported` runs after a successful import.
 */
export function renderSaves(el, { onImported = () => {}, only = null, title = "Saves" } = {}) {
  const here = savedHere();
  const lines = describeBackup(only ? Object.fromEntries(only.map((k) => [k, here[k]])) : here);
  el.innerHTML = `
    <div class="saves">
      <div class="set-group">${esc(title)}</div>
      <p class="set-note">Everything is saved in this browser on this computer. Export it to a file to back it up or move it to another computer; import a file to carry on from it.</p>
      <p class="small">${lines.length ? `On this computer: ${lines.map(esc).join("; ")}.` : "Nothing saved on this computer yet."}</p>
      <div class="saves-row">
        <button class="ghost" id="save-export"${lines.length ? "" : " disabled"}>Export to a file</button>
        <button class="ghost" id="save-import">Import a save file…</button>
      </div>
      <div class="small" id="save-msg"></div>
    </div>`;
  const msg = (t, ok) => { const m = el.querySelector("#save-msg"); if (m) { m.textContent = t; m.className = `small ${ok ? "pos" : "neg"}`; } };
  el.querySelector("#save-export")?.addEventListener("click", () => {
    const { text, name } = exportText(only);
    msg(download(name, text) ? `Saved ${name} to your downloads.` : "This browser cannot save files.", true);
  });
  el.querySelector("#save-import")?.addEventListener("click", async () => {
    const text = await pickFile();
    if (text == null) return;
    const r = importText(text);
    if (!r.ok) { if (r.reason !== "Cancelled.") msg(r.reason, false); return; }
    msg(`Loaded ${r.what.join("; ")}.`, true);
    onImported(r);
  });
}
