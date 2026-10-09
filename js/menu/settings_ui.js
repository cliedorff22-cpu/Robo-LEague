// settings_ui.js - one settings panel, used on the main menu, in the career
// and in the fight's pause overlay. It reads and writes the settings in
// localStorage (js/logic/settings.js says what they are) and tells its host
// what changed, so the host can apply it on the spot.

import { SETTINGS, SETTINGS_KEY, readSettings } from "../logic/settings.js";
import { MOBILE } from "../core/platform.js";

/**
 * Where the settings are kept. The phone build (mobile/) keeps its own, with
 * its own defaults, so lighter graphics on a phone never touch the desktop's.
 */
export const settingsKey = () => (MOBILE ? `${SETTINGS_KEY}.mobile` : SETTINGS_KEY);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** The settings as saved (defaults filled in). */
export function loadSettings() {
  let text = null;
  try { text = localStorage.getItem(settingsKey()); } catch { /* private mode */ }
  // A phone's first visit: its own defaults, then whatever it has saved.
  if (MOBILE?.settings) {
    let saved = {};
    try { saved = JSON.parse(text || "{}") || {}; } catch { saved = {}; }
    return readSettings(JSON.stringify({ ...MOBILE.settings, ...saved }));
  }
  return readSettings(text);
}

export function saveSettings(s) {
  try { localStorage.setItem(settingsKey(), JSON.stringify(s)); } catch { /* private mode: they last this session */ }
}

/**
 * Draw the settings into `el`.
 * @param opts.groups    only these groups (default: all)
 * @param opts.note      a line under the title (e.g. "applies at once")
 * @param opts.onChange  (settings, id) after a change is saved
 */
export function renderSettings(el, { groups = null, note = "", onChange = () => {} } = {}) {
  let s = loadSettings();
  const shown = SETTINGS.filter((x) => !groups || groups.includes(x.group));
  const byGroup = {};
  for (const x of shown) (byGroup[x.group] ||= []).push(x);
  el.innerHTML = `
    <div class="settings">
      ${note ? `<p class="set-note">${esc(note)}</p>` : ""}
      ${Object.entries(byGroup).map(([g, list]) => `
        <div class="set-group">${esc(g)}</div>
        ${list.map((x) => `
          <div class="set-row">
            <div class="set-label">${esc(x.label)}${x.help ? `<div class="set-help">${esc(x.help)}</div>` : ""}</div>
            <div class="set-control">${control(x, s[x.id])}</div>
          </div>`).join("")}`).join("")}
    </div>`;
  el.querySelectorAll("[data-set]").forEach((input) => {
    const id = input.dataset.set;
    const def = SETTINGS.find((x) => x.id === id);
    const apply = (v) => {
      s = { ...loadSettings(), [id]: v };
      saveSettings(s);
      el.querySelectorAll(`[data-set="${id}"]`).forEach((b) => b.classList?.toggle("on", b.dataset.value === String(v)));
      onChange(s, id);
    };
    if (def.type === "bool") input.addEventListener("change", () => apply(!!input.checked));
    else input.addEventListener("click", () => apply(input.dataset.value));
  });
  return { get settings() { return s; } };
}

function control(x, value) {
  if (x.type === "bool") return `<label class="set-switch"><input type="checkbox" data-set="${x.id}"${value ? " checked" : ""}><span></span></label>`;
  return `<div class="set-choices">${x.options.map(([k, label]) =>
    `<button type="button" class="set-choice${String(value) === k ? " on" : ""}" data-set="${x.id}" data-value="${esc(k)}">${esc(label)}</button>`).join("")}</div>`;
}
