// hud.js - the on-screen overlay, as plain DOM over the canvas.
//
// DOM rather than in-canvas text: it is far easier to restyle, it scales
// crisply, and when this port happens the HUD is the part you would rebuild
// in the target engine's UI system anyway. The HUD only ever READS state - it
// never mutates the match or the robot.

import { formatClock } from "../core/units.js";
import { conditionReport, worstFirst } from "../logic/condition.js";
import { EV } from "../core/bus.js";
import { familyOf, FAMILY } from "../logic/weapon.js";
import { MOBILE } from "../core/platform.js";

// What starts the match, in the words of this build's controls.
const START = MOBILE ? "tap START" : "ENTER start · ESC pause & keys";
// ...and the same, big, on the card shown before the bell.
const READY = MOBILE ? "Tap <b>START</b> to fight" : "Press <b>ENTER</b> to start";
const READY_NOTE = MOBILE ? "Pause (❚❚) shows these again, with the settings, any time."
  : "Esc pauses the fight and shows these again, with the settings.";

/**
 * @param corners  { [botId]: { corner: "red"|"blue", assembled, driver } } -
 *                 who is in the fight, for the intro, the count and the result
 * @param opponent the blue corner's assembled robot, for its card
 */
export function makeHud(root, { assembled, opponent: oppA = null, rules, cameraRig, bus, corners = {}, where = null, story = null, twoPlayer = false, tag = null }) {
  // Two slim cards - yours on the left, the opponent's on the right - with
  // only what matters mid-fight: overall health, the weapon, and the worst
  // damaged parts once something is actually hurt. The build sheet (weight,
  // top speed, push) belongs to the workshop; the keys are on the card
  // before the bell and on the pause screen (controlsHtml).
  const card = (side, a) => `
      <div class="panel bot-card ${side}" id="hud-${side}">
        <div class="panel-title"><span class="bc-name">${esc(a.name)} <span class="num">#${a.number}</span></span><span class="bc-tag" id="hud-${side}-tag"></span></div>
        <div class="bc-row"><span class="label">HEALTH</span><span class="meter"><i class="meter-fill hp" id="hud-${side}-hp"></i></span><span class="value" id="hud-${side}-hp-pct">100%</span></div>
        <div class="bc-row" id="hud-${side}-wrow"><span class="label">WEAPON</span><span class="meter"><i class="meter-fill spin" id="hud-${side}-spin"></i></span><span class="value" id="hud-${side}-wstate">-</span></div>
        <div class="damage" id="hud-${side}-damage"></div>
      </div>`;

  root.innerHTML = `
    <div class="hud-top">
      <div class="hud-clock">
        <div class="clock-time" id="hud-clock">3:00</div>
        <div class="clock-phase" id="hud-phase">${START}</div>
      </div>
      <div class="hud-cam" id="hud-cam"></div>
      ${tag ? `<div class="hud-tag" id="hud-tag"><b>${esc(tag.title)}</b>${tag.sub ? `<span>${esc(tag.sub)}</span>` : ""}</div>` : ""}
    </div>

    <div class="hud-left">${card("me", assembled)}</div>
    <div class="hud-right">${oppA ? card("opp", oppA) : ""}</div>

    <div class="hud-ready" id="hud-ready">
      <div class="ready-go">${READY}</div>
      <div class="ready-title">Controls</div>
      <div class="keys ready-keys">${controlsHtml(twoPlayer)}</div>
      <div class="ready-note">${READY_NOTE}</div>
    </div>
    <div class="hud-banner" id="hud-banner"></div>
    <div class="hud-count" id="hud-count"></div>
    <div class="hud-intro" id="hud-intro"></div>
    <div class="hud-results" id="hud-results"></div>
    <div class="hud-replay" id="hud-replay">
      <span class="dot"></span> REPLAY
      <div class="scrub"><div class="scrub-fill" id="hud-scrub"></div></div>
    </div>
  `;

  const el = (id) => root.querySelector(`#${id}`);
  const $clock = el("hud-clock"), $phase = el("hud-phase");
  const $cam = el("hud-cam"), $banner = el("hud-banner");
  const $replay = el("hud-replay"), $scrub = el("hud-scrub");
  const $count = el("hud-count"), $intro = el("hud-intro"), $results = el("hud-results");
  const $ready = el("hud-ready");
  const nameOf = (id) => corners[id]?.assembled.name ?? id;
  const cornerOf = (id) => corners[id]?.corner ?? "";
  const cardEls = (side) => el(`hud-${side}`) && {
    tag: el(`hud-${side}-tag`), hp: el(`hud-${side}-hp`), hpPct: el(`hud-${side}-hp-pct`),
    wrow: el(`hud-${side}-wrow`), spin: el(`hud-${side}-spin`), wstate: el(`hud-${side}-wstate`), damage: el(`hud-${side}-damage`),
  };
  const $me = cardEls("me"), $opp = cardEls("opp");
  // A wedge has no weapon to report.
  const armed = (a) => familyOf(a.stats.weapon?.class) !== FAMILY.NONE;
  if (!armed(assembled)) $me.wrow.hidden = true;
  if ($opp && !armed(oppA)) $opp.wrow.hidden = true;

  // ---- the camera's name, shown for a moment when it changes
  let camT = 0;
  function showCam() {
    const list = cameraRig.list();
    const i = list.findIndex((c) => c.id === cameraRig.id);
    if (i < 0) return;
    $cam.innerHTML = `<b>${i + 1}</b> ${esc(list[i].label)}`;
    $cam.classList.add("show");
    camT = 1.6;
  }
  bus.on(EV.CAMERA_CHANGED, showCam);

  // ---- transient banner
  let bannerT = 0;
  function banner(text, seconds = 1.6) {
    $banner.textContent = text;
    $banner.classList.add("show");
    bannerT = seconds;
  }
  bus.on(EV.CONTROL_CHANGED, ({ pilot }) =>
    banner(pilot === "ai" ? "AI HAS CONTROL" : "DRIVER HAS CONTROL"));
  // ---- Stage 4: the referee and the result
  const ids = Object.keys(corners);
  const weaponName = (a) => (a.parts.weapon ? a.parts.weapon.name : "no weapon");
  $intro.innerHTML = ids.length === 2 ? ids.map((id) => {
    const c = corners[id];
    return `<div class="intro-card ${c.corner}">
      <div class="intro-corner">${c.corner.toUpperCase()} CORNER</div>
      <div class="intro-name">${esc(c.assembled.name)} <span class="num">#${c.assembled.number}</span></div>
      <div class="intro-line">${esc(c.assembled.archetype.replace("_", " "))} · ${esc(weaponName(c.assembled))}</div>
      <div class="intro-line">${c.assembled.weightLb.toFixed(0)} lb · ${c.assembled.stats.topSpeedMph.toFixed(1)} mph</div>
      <div class="intro-line dim">driver: ${esc(c.driver)}</div>
    </div>`;
  }).join(`<div class="intro-vs">VS</div>`) + (where ? `<div class="intro-where">${esc(where.venue)}<span>${esc(where.layout)}</span></div>` : "")
    + (story && (story.grudge || story.level || story.series) ? introStory(story) : "") : "";

  /** A career fight's history: grudge match, rivalry, the series so far (rivalry.js). */
  function introStory(st) {
    const tag = st.grudge ? "GRUDGE MATCH" : st.level ? st.name.toUpperCase() : "REMATCH";
    const series = st.series ? `series ${st.series.w}-${st.series.l}` : "";
    return `<div class="intro-story${st.grudge ? " grudge" : ""} l${st.level || 0}"><b>${esc(tag)}</b>${series ? `<span>${esc(series)}</span>` : ""}</div>`;
  }

  let countHideT = 0;
  bus.on(EV.REF_COUNT, ({ botId, count, of }) => {
    $count.innerHTML = `<div class="count-n">${count}</div><div class="count-who ${cornerOf(botId)}">${esc(nameOf(botId))}</div>`;
    $count.classList.toggle("final", count >= of - 2);
    $count.classList.add("show");
    countHideT = 1.3;
  });
  bus.on(EV.KO, ({ botId }) => banner(`${nameOf(botId).toUpperCase()} IS KNOCKED OUT`, 2.5));
  bus.on(EV.TAP_OUT, ({ botId }) => banner(`${nameOf(botId).toUpperCase()} TAPS OUT`, 2.5));
  bus.on(EV.PIN_WARNING, ({ botId }) => banner(`${nameOf(botId).toUpperCase()}: RELEASE!`, 2.0));
  bus.on(EV.SEPARATE, () => banner("ROBOTS LOCKED - THE REFEREE SEPARATES THEM", 2.0));
  bus.on(EV.PIN_PENALTY, ({ botId }) => banner(`PINNING - ${nameOf(botId).toUpperCase()} LOSES CONTROL POINTS`, 2.0));

  const CAUSE = { pitted: "went down the pit", flipped: "flipped and could not recover", beached: "stranded with its wheels off the floor",
    disabled: "could not drive", stuck: "stuck and unable to move" };
  function showResults(r, keys = "<b>Enter</b> rematch &nbsp; <b>P</b> highlights &nbsp; <b>O</b> next opponent &nbsp; <b>M</b> menu") {
    if (!r) return;
    const [a, b] = ids.length === 2 ? ids : [r.winnerId, r.loserId];
    const how = r.method === "ko" ? `KNOCKOUT <span class="dim">· ${esc(nameOf(r.loserId))} ${CAUSE[r.cause] ?? "was counted out"}</span>`
      : r.method === "tapout" ? `TAP OUT <span class="dim">· ${esc(nameOf(r.loserId))} conceded</span>`
      : `${r.decision === "unanimous" ? "UNANIMOUS" : "SPLIT"} DECISION`;
    const at = r.method === "decision" ? "" : ` at ${formatClock(r.elapsedS)}`;
    let cards = "";
    if (r.cards) {
      const row = (label, k) => `<tr><td class="cat">${label}</td>${r.cards.map((c) =>
        `<td class="${cornerOf(a)}">${c.scores[a][k]}</td><td class="${cornerOf(b)}">${c.scores[b][k]}</td>`).join("")}</tr>`;
      cards = `<table class="cards">
        <tr><th></th>${r.cards.map((c) => `<th colspan="2">JUDGE ${c.judge}</th>`).join("")}</tr>
        <tr><th></th>${r.cards.map(() => `<th class="${cornerOf(a)}">${esc(shortTag(nameOf(a)))}</th><th class="${cornerOf(b)}">${esc(shortTag(nameOf(b)))}</th>`).join("")}</tr>
        ${row("Damage", "damage")}${row("Aggression", "aggression")}${row("Control", "control")}
        <tr class="total">${"<td>Total</td>"}${r.cards.map((c) =>
          `<td class="${c.winnerId === a ? "win" : ""}">${c.scores[a].total}</td><td class="${c.winnerId === b ? "win" : ""}">${c.scores[b].total}</td>`).join("")}</tr>
      </table>`;
    }
    $results.innerHTML = `
      <div class="res-label">WINNER</div>
      <div class="res-winner ${cornerOf(r.winnerId)}">${esc(nameOf(r.winnerId))}</div>
      <div class="res-how">${how}${at}</div>
      ${cards}
      <div class="res-keys">${keys}</div>`;
    $results.classList.add("show");
  }
  const shortTag = (n) => n.length > 10 ? n.slice(0, 9) + "." : n;

  // Hazards firing - pulverizers, saws coming up, the pit dropping - get no
  // words on screen: the arena's sound tells you (EV.HAZARD_FIRE is for audio).

  // Stage 2 events. The spectacle (sparks, dents, flying parts) hangs off these
  // same two signals, so the render layer never has to ask the logic layer
  // anything - it just listens.
  bus.on(EV.PART_FAILED, ({ name }) => banner(`${String(name).toUpperCase()} DESTROYED`, 2.0));
  bus.on(EV.HIT, (e) => {
    // Robot on robot only: a screw or a pulverizer biting is heard, not captioned.
    if (e.kind === "hazard") return;
    if (e.severity === "heavy" || e.severity === "catastrophic") {
      banner(e.severity === "catastrophic" ? "HUGE HIT!" : "BIG HIT!", 1.2);
    }
  });

  // The parts that are actually hurt, worst first - nothing while it is all
  // fresh. The full list is the pit's job (pit_ui.js).
  function renderDamage(a, target, limit) {
    const rows = worstFirst(conditionReport(a, rules)).filter((r) => r.condition < 0.995).slice(0, limit);
    target.innerHTML = rows.map((r) => {
      const pct = Math.round(r.condition * 100);
      return `<div class="dmg ${r.status}">
        <span class="dmg-name">${esc(shortName(r))}</span>
        <span class="dmg-bar"><i style="width:${pct}%"></i></span>
        <span class="dmg-pct">${pct}%</span>
      </div>`;
    }).join("");
  }
  const shortName = (r) =>
    r.key.startsWith("armor.") ? `armour ${r.key.split(".")[1]}` : r.key.replace(/([A-Z])/g, " $1");
  /** Overall health: what is left of the robot's hit points, all parts together. */
  function health(a) {
    let left = 0, full = 0;
    for (const r of conditionReport(a, rules)) { left += r.hpRemaining; full += r.hpFull; }
    return full > 0 ? left / full : 1;
  }
  function fillCard(c, sim, w, tagText) {
    c.tag.textContent = tagText;
    c.tag.hidden = !tagText;
    if (w && !c.wrow.hidden) {
      const dead = sim.effective().weapon.dead;
      c.wstate.textContent = dead ? "DEAD" : w.phase.toUpperCase();
      c.wstate.classList.toggle("bad", dead);
      c.spin.style.width = `${Math.round(w.spinPct * 100)}%`;
      c.spin.classList.toggle("ready", w.spinPct > 0.98);
    }
  }
  function fillHealth(c, a) {
    const h = health(a);
    const pct = Math.round(h * 100);
    c.hp.style.width = `${pct}%`;
    c.hp.classList.toggle("low", h < 0.5);
    c.hp.classList.toggle("crit", h < 0.25);
    c.hpPct.textContent = `${pct}%`;
    renderDamage(a, c.damage, 3);
  }

  let lastPhase = "idle";
  let dmgTimer = 0;

  return {
    banner,
    showResults,
    hideResults() { $results.classList.remove("show"); },

    /** Called once per rendered frame. */
    update(dt, { match, sim, pilot, replay, weapon, assembled: bot, rules, opponent }) {
      $clock.textContent = formatClock(match.clockS);
      $clock.classList.toggle("urgent", match.phase === "live" && match.clockS <= 30);

      $phase.textContent =
        match.phase === "idle"      ? START
      : match.phase === "countdown" ? `${Math.ceil(match.countdownS)}...`
      : match.phase === "paused"    ? "PAUSED"
      : match.phase === "ended"     ? "FINAL"
      : "LIVE";

      // Before the bell: how to start, and the controls.
      $ready.classList.toggle("show", match.phase === "idle" && !replay.playing);

      // Intro cards from the moment the match is called until the bell, then
      // a beat of FIGHT!
      const showIntro = match.phase === "countdown";
      $intro.classList.toggle("show", showIntro);
      if (match.phase === "countdown") {
        $phase.textContent = match.countdownS > 0.05 ? `${Math.ceil(match.countdownS)}` : "FIGHT!";
      }
      if (lastPhase === "countdown" && match.phase === "live") banner("FIGHT!", 1.0);
      lastPhase = match.phase;

      if (countHideT > 0) {
        countHideT -= dt;
        if (countHideT <= 0 || match.phase !== "live") $count.classList.remove("show");
      }

      if (bannerT > 0) {
        bannerT -= dt;
        if (bannerT <= 0) $banner.classList.remove("show");
      }
      if (camT > 0) {
        camT -= dt;
        if (camT <= 0) $cam.classList.remove("show");
      }

      // --- the two cards: tags and weapons every frame, health a few times a second
      if (bot) fillCard($me, sim, weapon, twoPlayer ? "P1" : pilot.mode === "ai" ? "AI" : "");
      if (opponent && $opp) fillCard($opp, opponent.sim, opponent.weapon, twoPlayer ? (opponent.human ? "P2" : "AI") : "");
      if (bot && rules) {
        dmgTimer -= dt;
        if (dmgTimer <= 0) {
          fillHealth($me, bot);
          if (opponent && $opp) fillHealth($opp, opponent.assembled);
          dmgTimer = 0.25;
        }
      }

      const playing = replay.playing;
      $replay.classList.toggle("show", playing);
      if (playing) $scrub.style.width = `${replay.progress() * 100}%`;
    },
  };
}

/**
 * Every control, for the card before the bell and the pause screen (main.js):
 * the keys, or on the phone build the touch controls (mobile/touch.js).
 */
export function controlsHtml(twoPlayer = false) {
  if (MOBILE) return twoPlayer ? `
    <div class="keys-p p1"><b>RED</b> &nbsp; left edge: a thumb anywhere there drives, <b>WEAPON</b> and <b>BRAKE</b> beside it</div>
    <div class="keys-p p2"><b>BLUE</b> &nbsp; right edge: the same, the other way round</div>
    <div>Drive: slide up to go forward, down to reverse, sideways to turn &nbsp; <b>WEAPON</b> hold to spin up / fire &nbsp; <b>BRAKE</b> hold to stop</div>
    <div><b>❚❚</b> pause &amp; settings &nbsp; <b>CAM</b> next camera &nbsp; <b>♪</b> sound</div>` : `
    <div><b>DRIVE</b> &nbsp; put a thumb anywhere on the left half and slide it: up goes forward, down reverses, sideways turns</div>
    <div><b>WEAPON</b> &nbsp; hold to spin up / fire &nbsp; <b>BRAKE</b> &nbsp; hold to stop dead</div>
    <div><b>❚❚</b> pause &amp; settings &nbsp; <b>CAM</b> next camera &nbsp; <b>♪</b> sound</div>
    <div class="dim">The pause menu also hands your robot to the AI, taps out, or quits.</div>`;
  return twoPlayer ? `
    <div class="keys-p p1"><b>RED</b> &nbsp; <b>W A S D</b> drive &nbsp; <b>Space</b> weapon &nbsp; <b>L Shift</b> brake &nbsp; <b>T T</b> tap out</div>
    <div class="keys-p p2"><b>BLUE</b> &nbsp; <b>arrows</b> drive &nbsp; <b>R Shift</b> or <b>/</b> weapon &nbsp; <b>.</b> brake &nbsp; <b>⌫ ⌫</b> tap out</div>
    <div><b>Tab</b> red to AI &nbsp; <b>\\</b> blue to AI</div>
    <div><b>C</b> next camera &nbsp; <b>1-7</b> pick &nbsp; <b>P</b> highlights</div>
    <div><b>Enter</b> start &nbsp; <b>Esc</b> pause &nbsp; <b>M</b> menu &nbsp; <b>N</b> sound</div>
    <div class="dim">Gamepads go to red, then blue.</div>` : `
    <div><b>W A S D</b> / arrows drive &nbsp; <b>Space</b> weapon (spin / fire) &nbsp; <b>Shift</b> brake</div>
    <div><b>C</b> next camera &nbsp; <b>1-7</b> pick &nbsp; <b>Tab</b> hand over to AI</div>
    <div><b>Enter</b> start &nbsp; <b>Esc</b> pause &nbsp; <b>P</b> highlights (after the bell)</div>
    <div><b>R</b> reset bot &nbsp; <b>T T</b> tap out &nbsp; <b>O</b> next opponent</div>
    <div><b>M</b> back to menu &nbsp; <b>N</b> sound on/off</div>`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
