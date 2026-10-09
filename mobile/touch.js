// touch.js - the phone build's on-screen controls for the fight.
//
// A thumb stick to drive (it appears wherever the thumb lands on its side of
// the screen), a WEAPON and a BRAKE button, and the buttons a keyboard player
// has keys for: start, pause, camera, highlights, back to the menu. The stick
// hands its throttle and steering to js/input/input.js through
// globalThis.ROBO_TOUCH; every button presses the key it stands for (Space,
// Enter, Escape, C...), so the fight itself runs exactly as on the desktop.
//
// Two players on one tablet (?p2=1): red's stick and buttons on the left
// edge, blue's on the right.

const params = new URLSearchParams(location.search);
const CAREER = params.get("career") === "1";
const TOURNEY = params.get("tourney") === "1";
const SCOUT = params.get("scout") === "1";
const TWO = params.get("p2") === "1" && !CAREER && params.get("driver") !== "ai";
const RADIUS = 58;                       // how far the stick travels, in CSS pixels
const DEAD = 0.12;

// ---------------------------------------------------------------- the sticks
const sticks = [null, null];             // per player: { throttle, steer } while a thumb is on it
globalThis.ROBO_TOUCH = { stick: (slot) => sticks[slot] || null };

/** The keyboard key each player's buttons press (see input.js SPLIT). */
const KEYS = [
  { weapon: "Space", brake: "ShiftLeft" },
  { weapon: "ShiftRight", brake: "Period" },
];

function press(code, type = "keydown") {
  window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
}
const tap = (code) => { press(code, "keydown"); setTimeout(() => press(code, "keyup"), 60); };

// ---------------------------------------------------------------- the DOM
const root = document.createElement("div");
root.id = "touch";
root.className = TWO ? "two" : "one";
root.innerHTML = `
  <div class="t-bar">
    <button class="t-small" data-tap="Escape" aria-label="Pause">❚❚</button>
    <button class="t-small" data-tap="KeyC" aria-label="Next camera">CAM</button>
    <button class="t-small" data-tap="KeyN" aria-label="Sound on or off">♪</button>
  </div>
  ${TWO ? `
    <div class="t-zone left" data-slot="0"></div><div class="t-zone right" data-slot="1"></div>
    <div class="t-btns p0"><button class="t-weapon red" data-hold="0:weapon">WEAPON</button><button class="t-brake" data-hold="0:brake">BRAKE</button></div>
    <div class="t-btns p1"><button class="t-weapon blue" data-hold="1:weapon">WEAPON</button><button class="t-brake" data-hold="1:brake">BRAKE</button></div>`
  : `
    <div class="t-zone left wide" data-slot="0"></div>
    <div class="t-btns solo"><button class="t-brake" data-hold="0:brake">BRAKE</button><button class="t-weapon" data-hold="0:weapon">WEAPON</button></div>`}
  <div class="t-stick" data-stick="0"><i></i></div>
  <div class="t-stick" data-stick="1"><i></i></div>
  <div class="t-context" id="t-context"></div>`;
document.body.appendChild(root);

// Portrait: the arena needs the width (fight-mobile.css shows this then).
const rotate = document.createElement("div");
rotate.id = "rotate";
rotate.innerHTML = `<div class="phone"></div>Turn your phone sideways<small>The arena needs the width.</small>`;
document.body.appendChild(rotate);

// Bar buttons: a tap is a key press.
root.querySelectorAll("[data-tap]").forEach((b) => b.addEventListener("pointerdown", (e) => { e.preventDefault(); tap(b.dataset.tap); }));

// Hold buttons: down while a finger is on them (several at once: pointer ids).
root.querySelectorAll("[data-hold]").forEach((b) => {
  const [slot, what] = b.dataset.hold.split(":");
  const code = KEYS[Number(slot)][what];
  const held = new Set();
  const down = (e) => { e.preventDefault(); if (!held.size) press(code, "keydown"); held.add(e.pointerId); b.classList.add("on"); b.setPointerCapture?.(e.pointerId); };
  const up = (e) => { if (!held.delete(e.pointerId)) return; if (!held.size) { press(code, "keyup"); b.classList.remove("on"); } };
  b.addEventListener("pointerdown", down);
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(ev, up);
});

// Stick zones: the stick appears where the thumb lands and follows it.
root.querySelectorAll("[data-slot]").forEach((zone) => {
  const slot = Number(zone.dataset.slot);
  const vis = root.querySelector(`[data-stick="${slot}"]`);
  const knob = vis.querySelector("i");
  let id = null, ox = 0, oy = 0;
  const move = (x, y) => {
    let dx = (x - ox) / RADIUS, dy = (y - oy) / RADIUS;
    const m = Math.min(1, Math.hypot(dx, dy));
    const len = Math.hypot(dx, dy) || 1;
    dx = (dx / len) * m; dy = (dy / len) * m;
    knob.style.transform = `translate(${dx * RADIUS}px, ${dy * RADIUS}px)`;
    // A dead zone in the middle, then the full range out to the rim.
    const k = m < DEAD ? 0 : (m - DEAD) / (1 - DEAD) / (m || 1);
    // Up drives forward; left turns left (the sim's steer is +1 = left).
    sticks[slot] = { throttle: -dy * k, steer: -dx * k };
  };
  zone.addEventListener("pointerdown", (e) => {
    if (id !== null) return;
    e.preventDefault();
    id = e.pointerId; ox = e.clientX; oy = e.clientY;
    zone.setPointerCapture?.(id);
    vis.style.left = `${ox}px`; vis.style.top = `${oy}px`;
    vis.classList.add("on");
    move(ox, oy);
  });
  zone.addEventListener("pointermove", (e) => { if (e.pointerId === id) move(e.clientX, e.clientY); });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null; sticks[slot] = null;
    knob.style.transform = "";
    vis.classList.remove("on");
  };
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) zone.addEventListener(ev, end);
});

// ---------------------------------------------------------------- what to do next
// The buttons a keyboard player has keys for, shown when they mean something:
// START before the bell, SKIP during a replay, and after the result REMATCH or
// CONTINUE, HIGHLIGHTS and MENU.
const ctx = root.querySelector("#t-context");
let shown = "";
function contextButtons(G) {
  if (!G) return [];
  if (G.replay.playing) return [["SKIP ▸▸", "KeyP", "big"]];
  const phase = G.match.phase;
  if (phase === "idle") return [["START", "Enter", "big go"]];
  if (phase === "ended") {
    const back = CAREER ? "BACK TO YOUR CAREER" : TOURNEY ? "BACK TO THE TOURNAMENT" : null;
    return back ? [[back, "KeyM", "big go"], ["HIGHLIGHTS", "KeyP", ""]]
      : [[SCOUT ? "RUN IT AGAIN" : "REMATCH", "Enter", "big go"], ["HIGHLIGHTS", "KeyP", ""], ["MENU", "KeyM", ""]];
  }
  return [];
}

// The pause overlay (main.js): buttons for what Esc, T T, Tab and M do.
function pauseButtons() {
  const card = document.querySelector("#pause-overlay.open .po-card");
  if (!card || card.querySelector(".t-pause")) return;
  const row = document.createElement("div");
  row.className = "t-pause";
  const items = [["RESUME", () => tap("Escape")],
    ["HAND TO THE AI", () => { tap("Escape"); setTimeout(() => tap("Tab"), 80); }],
    ["TAP OUT", () => { if (confirm("Tap out and lose this fight?")) { tap("Escape"); setTimeout(() => tap("KeyT"), 100); setTimeout(() => tap("KeyT"), 250); } }],
    [CAREER ? "BACK TO YOUR CAREER" : TOURNEY ? "BACK TO THE TOURNAMENT" : "QUIT TO THE MENU", () => { if (CAREER || TOURNEY ? confirm("Leave now? A fight you walk out of does not count.") : true) tap("KeyM"); }]];
  for (const [label, fn] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", fn);
    row.appendChild(b);
  }
  card.insertBefore(row, card.children[1] || null);
}

function frame() {
  const G = window.ROBO_LEAGUE;
  const want = contextButtons(G);
  const key = JSON.stringify(want);
  if (key !== shown) {
    shown = key;
    ctx.innerHTML = want.map(([label, code, cls]) => `<button class="t-ctx ${cls}" data-code="${code}">${label}</button>`).join("");
    ctx.querySelectorAll("[data-code]").forEach((b) => b.addEventListener("click", () => tap(b.dataset.code)));
  }
  // Driving controls only while there is something to drive.
  root.classList.toggle("ready", !!G);
  root.classList.toggle("replay", !!G?.replay.playing);
  pauseButtons();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Go full screen on the first touch where the browser allows it (not on iPhone:
// there, Add to Home Screen does it).
addEventListener("pointerdown", function full() {
  removeEventListener("pointerdown", full);
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen && !matchMedia("(display-mode: fullscreen), (display-mode: standalone)").matches) {
    el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  }
});
