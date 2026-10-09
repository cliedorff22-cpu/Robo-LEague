// workshop_ui.js - the Stage 6 workshop: build your robot part by part on a
// 3D turntable, paint it, and (if you want) ask the build advisor.
//
// Everything here is presentation. The rules are js/logic: workshop.js says
// what fits a slot and what a swap does to the numbers, garage.js prices it
// and fits it, advisor.js advises. Nothing is bought until "Buy & fit": until
// then the robot on the turntable is a DRAFT, so trying things is free.
//
// Part snapping: every slot has a hotspot on the 3D robot, placed from the
// chassis' attach points (parts.json `attach`) and the body's own geometry.
// Click a hotspot (or the part itself) to choose what goes there; drag a part
// card onto the robot and it snaps into the slot it belongs in, dropping into
// place on the turntable.

import { garageOf, quote, applyDesign, sellPart, spares, resaleOf, describeChange, shopTier, DEFAULT_PARTNER } from "../logic/garage.js";
import {
  slotsOf, setSlot, fitBody, summarize, candidates, defOf, mountsFor,
  MOUNT_NAMES, TEMPLATES, TEMPLATE_NAMES, EXTRAS, SLOT_NAMES,
} from "../logic/workshop.js";
import { advise } from "../logic/advisor.js";
import { nextFight, fieldedDef } from "../logic/career.js";
import { assembleRobot } from "../logic/build.js";
import { buildShape, routeFittings } from "../logic/shape.js";
import { wheelLayout } from "../sim/wheel_model.js";
import { WEAPON_NAMES } from "../logic/catalog.js";
import { PATTERNS, nameColour } from "../render/livery.js";
import { loadSettings } from "./settings_ui.js";

const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
const clone = (x) => JSON.parse(JSON.stringify(x));
const PERSONALITIES = [
  ["aggressive", "Aggressive - presses all fight, barely resets"],
  ["opportunistic", "Opportunistic - flanks, herds, punishes mistakes"],
  ["defensive", "Defensive - waits for openings, keeps its distance"],
];
/** The workshop turntable: still, turned by hand, starting three-quarters on. */
const STAGE_OPTS = (onPick) => ({ spin: false, interactive: true, angle: 0.75, onPick });
const TABS = [["parts", "Parts"], ["body", "Body & paint"], ["advisor", "Advisor"], ["spares", "Spares"]];
/** Short labels on the 3D hotspots. */
const HOT = { weapon: "Weapon", weaponMotor: "W.motor", wheel: "Wheels", drive: "Drive", motor: "Motors", battery: "Battery", electronics: "ESC", srimech: "Srimech", chassis: "Chassis" };

/**
 * @param ctx { app, reg, esc, showDef, career(), save(), back() }
 */
export function makeWorkshop(ctx) {
  const { app, reg, esc } = ctx;
  let draft = null;           // the design being edited
  let selected = "weapon";    // slot key
  let tab = "parts";
  let advice = null;          // last Advice from the advisor
  let thinking = null;        // what the advisor is working on
  let brief = "";
  let stage = null;
  let hotspots = [];          // { key, partKey, p: {x,y,z}, label }
  let hoverKey = null;

  const career = () => ctx.career();
  const garageDesign = () => {
    const g = garageOf(reg, career());
    return { name: g.name, body: clone(g.body), build: clone(g.build), livery: clone(g.livery), personality: g.personality,
      partner: g.partner ? clone(g.partner) : null };
  };
  const def = () => ({ ...defOf(reg, draft), league: career().membership[career().playerId], partner: draft.partner || undefined });
  // A multibot is edited one unit at a time: "main" or "partner".
  let unit = "main";
  const onPartner = () => unit === "partner" && !!draft.partner;
  /** The unit being edited: { build, body }. */
  const ub = () => (onPartner() ? draft.partner : draft);
  const setUnit = (build, body) => {
    if (onPartner()) draft = { ...draft, partner: { ...draft.partner, build, body } };
    else draft = { ...draft, build, body };
  };

  // ---------------------------------------------------------------- screen

  function open() {
    if (!draft) draft = garageDesign();
    const c = career();
    app.innerHTML = `
      <div class="screen workshop">
        <header class="bar">
          <button class="back" id="ws-back">Career</button>
          <div class="bar-title">Workshop</div>
          <div class="bar-hint">${esc(c.team)} · shop tier ${shopTier(reg, c)} · <b id="ws-cash">${money(c.cash)}</b></div>
        </header>
        <div class="ws-main">
          <section class="ws-stage-wrap" id="ws-stage-wrap">
            <canvas class="stage ws-stage" id="ws-stage"></canvas>
            <div class="ws-hot" id="ws-hot"></div>
            <div class="ws-drop" id="ws-drop">Drop to fit</div>
            <div class="ws-help muted small">Drag to turn · click a part or a marker to change it · drag a part card onto the robot to fit it</div>
            <div class="ws-stats" id="ws-stats"></div>
          </section>
          <section class="ws-side">
            <div class="tabs" id="ws-tabs"></div>
            <div class="tab-body" id="ws-body"></div>
            <div class="ws-foot" id="ws-foot"></div>
          </section>
        </div>
      </div>`;
    document.getElementById("ws-back").addEventListener("click", () => ctx.back());
    stage = ctx.showDef("ws-stage", def(), STAGE_OPTS(pickPart));
    stage?.onFrame(placeHotspots);
    wireDrop();
    refresh({ snap: ["all"] });
  }

  /** Redraw everything that depends on the draft; re-show the robot if it changed. */
  function refresh({ robot = true, snap = null } = {}) {
    if (robot && stage) {
      ctx.showDef("ws-stage", def(), STAGE_OPTS(pickPart));
      if (snap) stage.snap(snap);
      buildHotspots();
    }
    document.getElementById("ws-cash").textContent = money(career().cash);
    // Settings -> Build advisor off hides it.
    const tabs = TABS.filter(([id]) => id !== "advisor" || loadSettings().advisor);
    if (!tabs.some(([id]) => id === tab)) tab = "parts";
    document.getElementById("ws-tabs").innerHTML = tabs.map(([id, label]) => `<button class="tab${tab === id ? " on" : ""}" data-tab="${id}">${label}</button>`).join("");
    document.querySelectorAll("#ws-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; refresh({ robot: false }); }));
    statsHtml();
    bodyHtml();
    footHtml();
  }

  // ---------------------------------------------------------------- 3D hotspots

  /** Where each slot is on the robot, in its own frame. */
  function buildHotspots() {
    hotspots = [];
    let a, shape;
    try { a = assembleRobot(reg, def()); shape = buildShape(a); } catch { return; }
    const attach = Object.fromEntries((a.parts.chassis.spec.attach || []).map((x) => [x.id, x]));
    const inM = (v) => v * 0.0254;
    const at = (id, dy = 0) => attach[id] && { x: inM(attach[id].posIn[0]), y: inM(attach[id].posIn[1]) + dy, z: inM(attach[id].posIn[2]) };
    // The body's own top (not the weapon's - a disc stands well above it).
    const top = Math.max(...shape.pieces.filter((pc) => /^(core|body:|cheek|plate:top)/.test(pc.id)).flatMap((pc) => pc.points.map((q) => q.y)));
    const wv = shape.weapon?.visual;
    let wp = null;
    if (wv?.center) wp = wv.center;
    else if (wv?.pivot) wp = { x: wv.pivot.x + wv.reach, y: wv.pivot.y, z: 0 };
    if (draft.build.weapon) hotspots.push({ key: "weapon", partKey: "weapon", p: wp || at("weapon_front") || { x: a.dims.lengthM / 2, y: 0, z: 0 } });
    const wheels = wheelLayout(a).wheels;
    const w0 = wheels.find((w) => w.anchor.z > 0 && w.anchor.x > 0) || wheels[0];
    if (w0) hotspots.push({ key: "wheel", partKey: "wheel", p: { x: w0.anchor.x, y: w0.anchor.y - a.stats.wheelRadiusM * 0.3, z: w0.anchor.z + 0.03 } });
    // The insides (drive, motors, battery, ESC) share one marker over the
    // power bay - the slot list has each of them; the self-righter its bay.
    const power = at("power_bay") || at("drive_bay");
    if (power) hotspots.push({ key: "motor", label: "Internals", partKey: "chassis", p: { ...power, y: top + 0.02 } });
    const sr = at("srimech_bay");
    if (sr) hotspots.push({ key: "srimech", partKey: "chassis", p: { ...sr, x: sr.x - 0.06, y: top + 0.03, z: -a.dims.widthM * 0.25 } });
    hotspots.push({ key: "chassis", partKey: "chassis", p: { x: -a.dims.lengthM * 0.45, y: top * 0.5, z: a.dims.widthM * 0.3 } });
    // Armour: the middle of each fitted panel's pieces.
    const routes = routeFittings(shape, a);
    slotsOf(reg, draft.build).filter((s) => s.category === "armor").forEach((s) => {
      const idx = armourIndex(s.key);
      const key = idx >= 0 ? `armor.${idx}` : null;
      const pts = key ? shape.pieces.filter((pc) => routes.get(pc.id) === key).flatMap((pc) => pc.points) : [];
      const c = pts.length ? centroid(pts) : faceGuess(s.face, s.index, a.dims);
      hotspots.push({ key: s.key, partKey: key, p: c, armour: true, empty: !s.partId });
    });
    const hot = document.getElementById("ws-hot");
    if (!hot) return;
    hot.innerHTML = hotspots.map((h, i) => `<button class="hot${h.armour ? " arm" : ""}${h.empty ? " empty" : ""}${h.key === selected ? " on" : ""}" data-i="${i}" title="${esc(slotLabel(h.key))}">${esc(h.label || (h.armour ? slotLabel(h.key).replace(/ armour/, "") : HOT[h.key] || h.key))}</button>`).join("");
    hot.querySelectorAll(".hot").forEach((b) => {
      const h = hotspots[Number(b.dataset.i)];
      b.addEventListener("click", () => { unit = "main"; selectSlot(h.key); });
      b.addEventListener("mouseenter", () => stage?.highlight(h.partKey));
      b.addEventListener("mouseleave", () => stage?.highlight(hoverKey));
    });
  }

  function placeHotspots() {
    const hot = document.getElementById("ws-hot");
    if (!hot || !stage) return;
    hot.querySelectorAll(".hot").forEach((b) => {
      const h = hotspots[Number(b.dataset.i)];
      const q = h && stage.project(h.p);
      if (!q) return;
      b.style.transform = `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px) translate(-50%, -50%)`;
      b.classList.toggle("back", !q.front);
    });
  }

  /** A click on the robot itself: find the slot that part fills. */
  function pickPart(partKey) {
    if (!partKey) return;
    unit = "main";       // the markers and the picking are the main robot's
    if (partKey === "weapon") return selectSlot("weapon");
    if (partKey === "wheel") return selectSlot("wheel");
    const m = /^armor\.(\d+)$/.exec(partKey);
    if (m) {
      const s = slotsOf(reg, draft.build).find((x) => x.category === "armor" && armourIndex(x.key) === Number(m[1]));
      if (s) return selectSlot(s.key);
    }
    selectSlot("chassis");
  }

  function selectSlot(key) {
    selected = key;
    tab = "parts";
    const h = hotspots.find((x) => x.key === key);
    hoverKey = h?.partKey || null;
    stage?.highlight(hoverKey);
    document.querySelectorAll("#ws-hot .hot").forEach((b) => b.classList.toggle("on", hotspots[Number(b.dataset.i)]?.key === key));
    refresh({ robot: false });
  }

  /** The fitting index ("armor.N") of the panel in an armour slot, or -1. */
  function armourIndex(slotKey) {
    return slotsOf(reg, draft.build).find((s) => s.key === slotKey)?.fitIndex ?? -1;
  }

  // ---------------------------------------------------------------- fitting parts

  /** Put a part in a slot of the draft and drop it into place on the robot. */
  function fit(key, partId) {
    const u = ub();
    const build = setSlot(reg, u.build, key, partId);
    setUnit(build, fitBody(reg, u.body, build));
    // The second unit has no markers of its own: the whole robot drops in.
    const snapKey = onPartner() ? "all" : key === "weapon" ? "weapon" : key === "wheel" ? "wheel" : key.startsWith("armor:") ? `armor.${Math.max(0, armourIndex(key))}` : key === "chassis" ? "all" : "chassis";
    refresh({ snap: [snapKey] });
    stage?.highlight(snapKey === "all" ? null : snapKey);
    hoverKey = snapKey === "all" ? null : snapKey;
  }

  /** A part card dropped on the robot: the slot it belongs in. */
  function slotFor(partId) {
    const p = reg.part(partId);
    if (p.category !== "armor") return p.category;
    const faces = slotsOf(reg, ub().build).filter((s) => s.category === "armor" && s.face === p.spec.slot);
    return (faces.find((s) => s.key === selected) || faces.find((s) => !s.partId) || faces[0])?.key || null;
  }

  function wireDrop() {
    const wrap = document.getElementById("ws-stage-wrap");
    const drop = document.getElementById("ws-drop");
    if (!wrap) return;
    wrap.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("on"); });
    wrap.addEventListener("dragleave", () => drop.classList.remove("on"));
    wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("on");
      const id = e.dataTransfer?.getData("text/robo-part");
      if (!id || !reg.hasPart(id)) return;
      const key = slotFor(id);
      if (key) { selected = key; fit(key, id); }
    });
  }

  // ---------------------------------------------------------------- panels

  function statsHtml() {
    let s, ps = null;
    try {
      s = summarize(reg, def());
      if (draft.partner) ps = summarize(reg, defOf(reg, { build: draft.partner.build, body: draft.partner.body }));
    } catch (e) { document.getElementById("ws-stats").innerHTML = `<div class="neg">${esc(e.message)}</div>`; return; }
    if (ps) {
      // A multibot's units share the weight limit.
      const total = Math.round((s.weightLb + ps.weightLb) * 10) / 10;
      s = { ...s, weightLb: total, spareLb: Math.round((s.capLb - total) * 10) / 10,
        errors: [...s.errors, ...ps.errors.map((e) => `${draft.partner.name}: ${e}`), ...(total > s.capLb ? [`Multibot overweight: ${total} lb.`] : [])] };
    }
    const pctW = Math.min(1.15, s.weightLb / s.capLb);
    const over = s.weightLb > s.capLb;
    const chips = [
      s.invertible ? "Runs inverted" : s.selfRight !== "none" ? `Self-rights (${s.selfRight})` : "Can't self-right",
      `${WEAPON_NAMES[s.weaponClass] || s.weaponClass}`,
    ];
    document.getElementById("ws-stats").innerHTML = `
      <div class="ws-weight${over ? " over" : ""}">
        <div class="ws-weight-bar"><div style="width:${(pctW / 1.15 * 100).toFixed(1)}%"></div><span class="cap" style="left:${(1 / 1.15 * 100).toFixed(1)}%"></span></div>
        <div class="ws-weight-num"><b>${s.weightLb}</b> / ${s.capLb} lb ${over ? `<span class="neg">${(s.weightLb - s.capLb).toFixed(1)} over</span>` : `<span class="muted">${s.spareLb} spare</span>`}</div>
      </div>
      <div class="card-stats">
        <div><span>Speed</span><b>${s.topSpeedMph} mph</b></div><div><span>Push</span><b>${s.pushRatio}x</b></div>
        <div><span>Turn</span><b>${s.pivot}x</b></div><div><span>Armour</span><b>${s.armourHp} hp</b></div>
        ${s.energyKJ ? `<div><span>Weapon</span><b>${s.energyKJ} kJ</b></div>` : ""}${s.spinUpS ? `<div><span>Spin-up</span><b>${s.spinUpS} s</b></div>` : ""}
        <div><span>Clearance</span><b>${s.clearanceIn}"</b></div>
      </div>
      ${ps ? `<div class="card-stats ws-partner-stats"><div><span>${esc(draft.partner.name)}</span><b>${ps.weightLb} lb</b></div><div><span>Speed</span><b>${ps.topSpeedMph} mph</b></div><div><span>Push</span><b>${ps.pushRatio}x</b></div><div><span>Weapon</span><b>${esc(ps.weaponName)}</b></div></div>` : ""}
      <div class="ws-chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}${ps ? `<span class="chip">Multibot</span>` : ""}</div>
      ${s.errors.map((e) => `<div class="ws-err">${esc(e)}</div>`).join("")}
      ${s.warnings.slice(0, 2).map((w) => `<div class="ws-warn">${esc(w)}</div>`).join("")}`;
  }

  function bodyHtml() {
    const el = document.getElementById("ws-body");
    if (tab === "parts") el.innerHTML = partsHtml();
    else if (tab === "body") el.innerHTML = paintHtml();
    else if (tab === "advisor") el.innerHTML = advisorHtml();
    else el.innerHTML = sparesHtml();
    wireBody(el);
  }

  function slotLabel(key) {
    return slotsOf(reg, ub().build).find((s) => s.key === key)?.label || SLOT_NAMES[key] || key;
  }

  function partsHtml() {
    const u = ub();
    const slots = slotsOf(reg, u.build);
    const g = garageOf(reg, career());
    const garage = onPartner() ? g.partner?.build : g.build;
    const was = garage ? Object.fromEntries(slotsOf(reg, garage).map((s) => [s.key, s.partId])) : {};
    if (!slots.some((s) => s.key === selected)) selected = "weapon";
    const list = candidates(reg, career(), u, selected, { minibot: onPartner() });
    const slot = slots.find((s) => s.key === selected) || slots[0];
    const chip = (k, v, unit, good) => (v ? `<span class="d ${(v > 0) === good ? "up" : "down"}">${v > 0 ? "+" : ""}${Math.round(v * 10) / 10}${unit} ${k}</span>` : "");
    return `
      ${multibotHtml()}
      <div class="ws-slots">${slots.map((s) => `
        <button class="ws-slot${s.key === selected ? " on" : ""}${s.partId !== (was[s.key] ?? null) ? " changed" : ""}" data-slot="${s.key}">
          <span class="ws-slot-name">${esc(s.label)}</span><span class="ws-slot-part">${s.partId ? esc(reg.part(s.partId).name) : `<i class="muted">empty</i>`}</span>
        </button>`).join("")}</div>
      <div class="scout-sub">${esc(slot.label)} - pick one, or drag it onto the robot</div>
      <div class="ws-parts">
        ${slot.optional && slot.partId ? `<div class="ws-part none" data-fit="" data-key="${slot.key}"><div class="ws-part-name">Leave it empty</div></div>` : ""}
        ${list.map((x) => `
          <div class="ws-part${x.fitted ? " fitted" : ""}${x.locked ? " locked" : ""}${x.legal ? "" : " illegal"}" draggable="${x.locked ? "false" : "true"}" data-fit="${x.part.id}" data-key="${slot.key}">
            <div class="ws-part-name">${esc(x.part.name)} <span class="tier">T${x.part.tier ?? 1}</span></div>
            <div class="ws-part-meta">${x.part.weight} lb · ${x.owned ? `<b class="pos">owned${x.owned > 1 ? ` x${x.owned}` : ""}</b>` : x.locked ? `<span class="neg">${esc(x.reason)}</span>` : money(x.price)}${specLine(x.part)}</div>
            <div class="ws-deltas">${x.fitted ? `<span class="muted">fitted</span>` : x.delta ? [
              chip("lb", x.delta.weightLb, "", false), chip("mph", x.delta.topSpeedMph, "", true), chip("push", x.delta.pushRatio, "", true),
              chip("kJ", x.delta.energyKJ, "", true), chip("hp", x.delta.armourHp, "", true),
            ].join("") : ""}${!x.legal && x.after ? `<span class="d down">${esc(x.after.errors[0] || "illegal")}</span>` : ""}</div>
          </div>`).join("")}
      </div>`;
  }

  /** The multibot switch, and which unit the parts list is for. */
  function multibotHtml() {
    if (!draft.partner) return `<div class="ws-multi"><span class="muted small">One robot.</span> <button class="ghost tiny" data-multi="on">Make it a multibot (add a second unit)</button></div>`;
    return `<div class="ws-multi">
      <div class="ws-units">
        <button class="ws-unit${unit === "main" ? " on" : ""}" data-unit="main">${esc(draft.name)}</button>
        <button class="ws-unit${unit === "partner" ? " on" : ""}" data-unit="partner">${esc(draft.partner.name)}</button>
      </div>
      <button class="ghost tiny" data-multi="off">Back to one robot</button>
    </div>`;
  }

  function specLine(p) {
    const s = p.spec;
    if (p.category === "weapon") return s.class === "static" ? " · wedge" : ` · ${WEAPON_NAMES[s.class]}${s.radiusIn ? ` ${s.radiusIn * 2}"` : ""}`;
    if (p.category === "armor") return ` · ${s.material?.replace(/_/g, " ")} ${s.thicknessIn ?? ""}" · ${p.hp} hp`;
    if (p.category === "weaponMotor") return ` · ${(s.powerW / 1000).toFixed(1)} kW`;
    if (p.category === "motor") return ` · ${s.count} motors`;
    if (p.category === "chassis") return ` · ${s.sizeIn.join("x")}"`;
    if (p.category === "wheel") return ` · ${s.diameterIn ?? ""}" x${s.count}`;
    return "";
  }

  function paintHtml() {
    if (onPartner()) {
      const p = draft.partner;
      const pm = mountsFor(reg, p.build);
      return `${multibotHtml()}
        <label class="ws-field">Second unit's name <input id="ws-pname" maxlength="28" value="${esc(p.name)}"></label>
        <label class="ws-field">Shape <select id="ws-ptemplate">${TEMPLATES.map((t) => `<option value="${t}"${p.body.template === t ? " selected" : ""}>${TEMPLATE_NAMES[t] || t}</option>`).join("")}</select></label>
        <label class="ws-field">Weapon mount <select id="ws-pmount"${pm.length < 2 ? " disabled" : ""}>${pm.map((m) => `<option value="${m}"${p.body.mount === m ? " selected" : ""}>${MOUNT_NAMES[m] || m}</option>`).join("")}</select></label>
        <p class="muted small">It wears the main robot's paint, and an AI driver drives it beside you.</p>`;
    }
    const lv = draft.livery || {};
    const mounts = mountsFor(reg, draft.build);
    const extras = new Set((draft.body.extras || []).map((e) => e.type));
    return `
      ${draft.partner ? multibotHtml() : ""}
      <label class="ws-field">Name <input id="ws-name" maxlength="28" value="${esc(draft.name)}"></label>
      <label class="ws-field">Driver (your AI, and the arena when you press Tab)
        <select id="ws-pers">${PERSONALITIES.map(([v, l]) => `<option value="${v}"${draft.personality === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      <div class="scout-sub">Body</div>
      <label class="ws-field">Shape <select id="ws-template">${TEMPLATES.map((t) => `<option value="${t}"${draft.body.template === t ? " selected" : ""}>${TEMPLATE_NAMES[t] || t}</option>`).join("")}</select></label>
      <label class="ws-field">Weapon mount <select id="ws-mount"${mounts.length < 2 ? " disabled" : ""}>${mounts.map((m) => `<option value="${m}"${draft.body.mount === m ? " selected" : ""}>${MOUNT_NAMES[m] || m}</option>`).join("")}</select></label>
      <div class="ws-extras">${EXTRAS.map((x) => `<label><input type="checkbox" data-extra="${x}"${extras.has(x) ? " checked" : ""}> ${x === "wheelGuards" ? "wheel guards" : x}</label>`).join("")}</div>
      <p class="muted small">Forks and a plow are real: a horizontal spinner that hits them glances off.</p>
      <div class="scout-sub">Paint</div>
      <div class="ws-colors">
        <label>Main <input type="color" id="ws-c1" value="${lv.primary || "#b8babf"}"></label>
        <label>Trim <input type="color" id="ws-c2" value="${lv.secondary || "#202227"}"></label>
        <label>Accent <input type="color" id="ws-c3" value="${lv.accent || "#f0c419"}"></label>
      </div>
      <label class="ws-field">Pattern <select id="ws-pattern">${PATTERNS.map((p) => `<option value="${p}"${(lv.pattern || "") === p ? " selected" : ""}>${p}</option>`).join("")}</select></label>
      <div class="scout-sub">Name on the robot</div>
      <div class="ws-colors">
        <label>Colour <input type="color" id="ws-ctext" value="${nameColour(lv)}"></label>
        <button class="ghost tiny" id="ws-ctext-auto"${lv.text ? "" : " disabled"} title="Pick a colour that stands out on the paint">Auto</button>
      </div>
      <label class="ws-field">Size <span class="ws-range"><input type="range" id="ws-namesize" min="40" max="100" step="5" value="${namePct(lv)}"><b id="ws-namesize-v">${namePctLabel(namePct(lv))}</b></span></label>
      <p class="muted small">The name finds the biggest flat panel it fits on by itself; the slider only makes it smaller.</p>`;
  }

  /** The name size slider: 100 is the largest that fits. */
  function namePct(lv) { return Math.round(Math.min(1, Math.max(0.4, Number(lv.nameSize) || 1)) * 100); }
  function namePctLabel(p) { return p >= 100 ? "largest that fits" : `${p}%`; }

  function advisorHtml() {
    const c = career();
    const nf = c.seasonOver ? null : nextFight(reg, c);
    const oppName = nf ? fieldedDef(reg, c, nf.oppId).name : null;
    return `
      <p class="muted small">The advisor is optional and works offline: it reasons from your parts, the measured physics
        matchups, and trial fights it runs on this machine. It only suggests - nothing is bought until you press Buy &amp; fit.</p>
      <div class="ws-ask">
        <textarea id="ws-brief" rows="2" placeholder='Describe a robot: "a low wedge with a lifter", "fast drum under $12,000", "vertical disc called Molar Bear"'>${esc(brief)}</textarea>
        <button class="fight small" data-ask="design">Design it</button>
      </div>
      <div class="ws-ask-row">
        ${nf ? `<button class="ghost" data-ask="opponent">Tailor for ${esc(oppName)}</button><button class="ghost" data-ask="fight">Game plan vs ${esc(oppName)}</button>` : `<span class="muted small">No fight drawn right now.</span>`}
        <button class="ghost" data-ask="season">Season plan</button>
      </div>
      ${thinking ? `<div class="panel ws-advice thinking">Thinking: ${esc(thinking)}... (running trial fights)</div>` : advice ? adviceHtml(advice) : ""}`;
  }

  function adviceHtml(a) {
    return `
      <div class="panel ws-advice">
        <div class="ws-adv-title">${esc(a.title)}</div>
        <div class="ws-adv-sum">${esc(a.summary)}</div>
        <ul class="scout-list">${(a.points || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
        ${a.design ? `<button class="fight small" data-load="design">Load into the workshop</button>` : ""}
        ${(a.options || []).map((o, i) => `
          <div class="ws-opt">
            <div><b>${esc(o.label)}</b> <span class="pos">${Math.round(o.winRate * 100)}% (+${Math.round(o.delta * 100)})</span> <span class="muted">${o.cost ? money(o.cost) : "free"}</span></div>
            ${o.notes ? `<div class="muted small">${esc(o.notes)}</div>` : ""}
            <button class="ghost tiny" data-load="${i}">Try it</button>
          </div>`).join("")}
      </div>`;
  }

  function sparesHtml() {
    const c = career();
    const sp = Object.entries(spares(reg, c));
    const g = garageOf(reg, c);
    return `
      <div class="scout-sub">Spare parts</div>
      ${sp.length ? `<table class="ledger">${sp.map(([id, n]) => `<tr><td>${esc(reg.part(id).name)}${n > 1 ? ` x${n}` : ""}</td><td class="muted">${reg.part(id).weight} lb</td><td><button class="ghost tiny" data-sell="${id}">Sell ${money(resaleOf(reg, id))}</button></td></tr>`).join("")}</table>`
        : `<p class="muted">No spares. Parts you take off stay here, to fit again or sell at half price.</p>`}
      <div class="scout-sub">Build log - ${esc(g.name)} v${esc(g.version)}</div>
      ${g.log.length ? `<table class="ledger">${g.log.slice().reverse().map((l) => `<tr><td class="muted">S${l.season} v${esc(l.version)}</td><td colspan="2">${esc(l.text)}</td></tr>`).join("")}</table>` : `<p class="muted">Nothing changed yet.</p>`}`;
  }

  function footHtml() {
    const c = career();
    const g = garageOf(reg, c);
    const q = quote(reg, c, draft.build, draft.partner?.build);
    let s = null;
    try { s = summarize(reg, def()); } catch { s = null; }
    const changes = describeChange(reg, g.build, draft.build);
    if (!g.partner !== !draft.partner) changes.push(draft.partner ? `add ${draft.partner.name} (multibot)` : `drop ${g.partner.name}`);
    else if (draft.partner && stable(draft.partner) !== stable(g.partner)) changes.push(`${draft.partner.name} changed`);
    if (draft.partner) {
      try {
        const ps = summarize(reg, defOf(reg, { build: draft.partner.build, body: draft.partner.body }));
        const total = (s?.weightLb || 0) + ps.weightLb;
        if (s && total > s.capLb) s = { ...s, errors: [...s.errors, `Multibot overweight: ${Math.round(total * 10) / 10} lb.`] };
        if (s) s = { ...s, errors: [...s.errors, ...ps.errors.map((e) => `${draft.partner.name}: ${e}`)] };
      } catch { /* shown in the stats panel */ }
    }
    // Compared in a canonical form: fitting a part and taking it off again
    // must not count as a change.
    const look = (d) => stable([d.name, fitBody(reg, d.body, d.build), d.livery || {}, d.personality]);
    const cosmetic = look(draft) !== look(g);
    const dirty = changes.length || cosmetic;
    const problems = [...(s?.errors || []), ...q.locked.map((l) => `${l.name}: ${l.reason}`), ...(q.affordable ? [] : [`Costs ${money(q.total)} - you have ${money(c.cash)}.`])];
    document.getElementById("ws-foot").innerHTML = `
      <div class="ws-foot-text">${dirty ? `${changes.length ? esc(changes.slice(0, 3).join("; ")) + (changes.length > 3 ? ` +${changes.length - 3} more` : "") : "Name, body or paint changed"}
        <div>${q.buy.length ? `New parts: <b>${money(q.total)}</b> <span class="muted">(${q.buy.map((b) => esc(b.name)).join(", ")})</span>` : `<span class="muted">No parts to buy.</span>`}</div>`
        : `<span class="muted">This is your robot as it stands. Change a part to start a new design.</span>`}
        ${problems.length && dirty ? `<div class="neg small">${esc(problems[0])}</div>` : ""}</div>
      <div class="ws-foot-btns">
        <button class="ghost" id="ws-revert"${dirty ? "" : " disabled"}>Revert</button>
        <button class="fight small" id="ws-apply"${dirty && !problems.length ? "" : " disabled"}>${q.total ? `Buy & fit (${money(q.total)})` : "Save design"}</button>
      </div>`;
    document.getElementById("ws-revert").addEventListener("click", () => actions.revert());
    document.getElementById("ws-apply").addEventListener("click", () => actions.apply());
  }

  function wireBody(el) {
    el.querySelectorAll("[data-slot]").forEach((b) => b.addEventListener("click", () => selectSlot(b.dataset.slot)));
    el.querySelectorAll("[data-unit]").forEach((b) => b.addEventListener("click", () => actions.unit(b.dataset.unit)));
    el.querySelectorAll("[data-multi]").forEach((b) => b.addEventListener("click", () => actions.multibot(b.dataset.multi === "on")));
    const pOn = (id, fn) => document.getElementById(id)?.addEventListener("change", fn);
    pOn("ws-pname", (e) => { draft = { ...draft, partner: { ...draft.partner, name: e.target.value.trim().slice(0, 28) || "Minibot" } }; refresh({ robot: false }); });
    pOn("ws-ptemplate", (e) => { const p = draft.partner; draft = { ...draft, partner: { ...p, body: fitBody(reg, { ...p.body, template: e.target.value }, p.build) } }; refresh({ snap: ["all"] }); });
    pOn("ws-pmount", (e) => { const p = draft.partner; draft = { ...draft, partner: { ...p, body: fitBody(reg, { ...p.body, mount: e.target.value }, p.build) } }; refresh({ snap: ["all"] }); });
    el.querySelectorAll("[data-fit]").forEach((b) => {
      b.addEventListener("click", () => { if (!b.classList.contains("locked")) fit(b.dataset.key, b.dataset.fit || null); });
      b.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/robo-part", b.dataset.fit); e.dataTransfer.effectAllowed = "copy"; });
    });
    const on = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);
    on("ws-name", "input", (e) => { draft = { ...draft, name: e.target.value }; footHtml(); });
    on("ws-pers", "change", (e) => { draft = { ...draft, personality: e.target.value }; footHtml(); });
    on("ws-template", "change", (e) => { draft = { ...draft, body: fitBody(reg, { ...draft.body, template: e.target.value }, draft.build) }; refresh({ snap: ["all"] }); });
    on("ws-mount", "change", (e) => { draft = { ...draft, body: fitBody(reg, { ...draft.body, mount: e.target.value }, draft.build) }; refresh({ snap: ["weapon"] }); });
    el.querySelectorAll("[data-extra]").forEach((x) => x.addEventListener("change", () => {
      const keep = (draft.body.extras || []).filter((e) => e.type !== x.dataset.extra);
      draft = { ...draft, body: { ...draft.body, extras: x.checked ? [...keep, { type: x.dataset.extra }] : keep } };
      refresh({ snap: ["chassis"] });
    }));
    let paintT = null;
    const paint = () => {
      const lv = { ...draft.livery,
        primary: document.getElementById("ws-c1").value, secondary: document.getElementById("ws-c2").value,
        accent: document.getElementById("ws-c3").value, pattern: document.getElementById("ws-pattern").value };
      draft = { ...draft, livery: lv };
      clearTimeout(paintT);
      paintT = setTimeout(() => refresh(), 120);   // colour pickers fire on every drag step
    };
    for (const id of ["ws-c1", "ws-c2", "ws-c3"]) on(id, "input", paint);
    on("ws-pattern", "change", paint);
    // The name's colour and size redraw only the robot, so a drag on the
    // slider (or the colour picker) is not cut short by the panel redrawing.
    const repaint = () => {
      clearTimeout(paintT);
      paintT = setTimeout(() => { if (stage) { ctx.showDef("ws-stage", def(), STAGE_OPTS(pickPart)); buildHotspots(); } footHtml(); }, 120);
    };
    on("ws-ctext", "input", (e) => {
      draft = { ...draft, livery: { ...draft.livery, text: e.target.value } };
      const auto = document.getElementById("ws-ctext-auto");
      if (auto) auto.disabled = false;
      repaint();
    });
    on("ws-ctext-auto", "click", () => {
      const { text, ...rest } = draft.livery || {};
      draft = { ...draft, livery: rest };
      refresh();
    });
    on("ws-namesize", "input", (e) => {
      const pct = Number(e.target.value);
      const { nameSize, ...rest } = draft.livery || {};
      draft = { ...draft, livery: pct >= 100 ? rest : { ...rest, nameSize: pct / 100 } };
      document.getElementById("ws-namesize-v").textContent = namePctLabel(pct);
      repaint();
    });
    on("ws-brief", "input", (e) => { brief = e.target.value; });
    el.querySelectorAll("[data-ask]").forEach((b) => b.addEventListener("click", () => actions.ask(b.dataset.ask)));
    el.querySelectorAll("[data-load]").forEach((b) => b.addEventListener("click", () => actions.load(b.dataset.load)));
    el.querySelectorAll("[data-sell]").forEach((b) => b.addEventListener("click", () => actions.sell(b.dataset.sell)));
  }

  // ---------------------------------------------------------------- actions
  // Everything a button does, in one place - the headless menu check drives these.

  const actions = {
    open() { draft = null; advice = null; thinking = null; selected = "weapon"; tab = "parts"; open(); },
    fit(key, partId) { fit(key, partId); },
    select(key) { selectSlot(key); },
    /** Edit the main robot or a multibot's second unit. */
    unit(which) { unit = which === "partner" && draft.partner ? "partner" : "main"; selected = "weapon"; refresh({ robot: false }); },
    /** Make it a multibot (a second unit, a minibot wedge to start) or back to one robot. */
    multibot(on) {
      draft = { ...draft, partner: on ? clone(draft.partner || garageOf(reg, career()).partner || DEFAULT_PARTNER) : null };
      unit = on ? "partner" : "main";
      selected = "weapon";
      refresh({ snap: ["all"] });
    },
    tab(id) { tab = id; refresh({ robot: false }); },
    revert() { draft = garageDesign(); if (!draft.partner) unit = "main"; refresh({ snap: ["all"] }); },
    apply() {
      const r = applyDesign(reg, career(), draft);
      if (!r.ok) { alertBox(r.errors[0]); return r; }
      ctx.save();
      draft = garageDesign();
      refresh({ snap: ["all"] });
      return r;
    },
    sell(id) { sellPart(reg, career(), id); ctx.save(); refresh({ robot: false }); },
    /** Ask the advisor (synchronously: the headless check calls this). */
    askNow(kind, text = brief) {
      const c = career();
      const nf = c.seasonOver ? null : nextFight(reg, c);
      advice = advise(reg, { kind, career: c, design: draft, brief: text, oppId: nf?.oppId });
      thinking = null;
      return advice;
    },
    ask(kind) {
      brief = document.getElementById("ws-brief")?.value ?? brief;
      thinking = { design: "designing", opponent: "testing changes", fight: "planning", season: "testing upgrades" }[kind];
      tab = "advisor";
      refresh({ robot: false });
      // Let the "thinking" note paint before the trial fights run.
      setTimeout(() => { try { actions.askNow(kind); } catch (e) { thinking = null; advice = { title: "The advisor hit a problem", summary: String(e.message || e), points: [] }; } refresh({ robot: false }); }, 30);
    },
    load(which) {
      if (!advice) return;
      const d = which === "design" ? advice.design : advice.options?.[Number(which)]?.design;
      if (!d) return;
      const prevWeapon = draft.build.weapon;
      draft = { ...draft, ...clone(d), livery: d.livery || draft.livery };
      refresh({ snap: [prevWeapon !== draft.build.weapon ? "all" : "chassis"] });
    },
    get draft() { return draft; },
  };

  function alertBox(msg) {
    const f = document.getElementById("ws-foot");
    if (f) f.insertAdjacentHTML("afterbegin", `<div class="neg small">${esc(msg)}</div>`);
  }

  return {
    actions,
    open: () => actions.open(),
    /** Esc: back out of the workshop. */
    keys(e) { if (e.key === "Escape") { ctx.back(); return true; } return false; },
  };
}

/** JSON with object keys sorted, so equal values compare equal. */
function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(",")}}`;
  return JSON.stringify(x ?? null);
}

function centroid(pts) {
  const c = { x: 0, y: 0, z: 0 };
  for (const p of pts) { c.x += p.x; c.y += p.y; c.z += p.z; }
  return { x: c.x / pts.length, y: c.y / pts.length, z: c.z / pts.length };
}

/** Where an empty armour slot would be, for its hotspot. */
function faceGuess(face, index, dims) {
  const L = dims.lengthM / 2, H = dims.heightM / 2, W = dims.widthM / 2;
  if (face === "front") return { x: L, y: 0, z: 0 };
  if (face === "rear") return { x: -L, y: 0, z: 0 };
  if (face === "top") return { x: 0, y: H, z: 0 };
  return { x: 0, y: 0, z: index ? -W : W };
}

