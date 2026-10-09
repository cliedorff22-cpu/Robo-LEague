// menu.js - the front end: main menu, Quick Fight, Settings, Credits, Career.
//
// Plain DOM, one screen at a time, routed by the URL hash (#quick, #settings,
// #credits, #career, #career/workshop) so the back and forward arrows (nav.js)
// and the browser's own buttons work. The fight itself is
// fight.html; Quick Fight hands over to it with the two robots in the URL.
//
// Quick Fight and Career are live (Career's screens are js/menu/career_ui.js);
// Settings says what is coming.

import { loadRegistryFromFetch } from "../data/load.js";
import { dataDir } from "../core/platform.js";
import { assembleRobot, assemblePartner } from "../logic/build.js";
import { catalog, filterCatalog, specCard, LEAGUE_NAMES } from "../logic/catalog.js";
import { makeMaterials } from "../render/materials.js";
import { makePreviewStage } from "../render/preview_stage.js";
import { makeCareerUi, HALL_KEY } from "./career_ui.js";
import { makeTournamentUi } from "./tournament_ui.js";
import { loadHall } from "../logic/halloffame.js";
import { renderSettings } from "./settings_ui.js";
import { renderSaves } from "./saves_ui.js";
import { makeNav } from "./nav.js";
import { venueIds, venueOf, layoutIds, layoutOf, DEFAULT_VENUE } from "../logic/arenas.js";

const STORE_KEY = "robo-league.quickfight";
const CORNERS = ["red", "blue"];
const LEAGUE_CHIPS = [["all", "All"], ["world", "World"], ["elite", "Elite"], ["pro", "Pro"], ["rookie", "Rookie"], ["exhibition", "Exhibition"]];

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

boot().catch((err) => {
  console.error(err);
  const status = document.getElementById("boot-status");
  if (status) status.textContent = `Failed to start: ${err?.message || err}`;
});

async function boot() {
  const reg = await loadRegistryFromFetch(dataDir());
  const entries = catalog(reg);
  const byId = new Map(entries.map((e) => [e.id, e]));
  let mats = null;                  // made on first preview: painting textures takes a moment
  const getMats = () => (mats ||= makeMaterials({ arenaRepeat: 4, style: reg.arena.style }));

  // ---------------------------------------------------------------- state
  const saved = loadPicks();
  const pick = {
    red: byId.has(saved.red) ? saved.red : reg.playerId,
    blue: byId.has(saved.blue) ? saved.blue : (byId.has("spinner_test") ? "spinner_test" : entries[0].id),
    driver: saved.driver === "ai" ? "ai" : "you",
    // Blue: the AI, or a second player on the same keyboard (input.js readPlayer).
    blueDriver: saved.blueDriver === "p2" ? "p2" : "ai",
    // Where: a venue and a hazard layout (data/arenas.json); "random" layout
    // draws one from the venue's pool.
    venue: venueOf(reg, saved.venue) ? saved.venue : DEFAULT_VENUE,
    layout: saved.layout === "random" || layoutOf(reg, saved.layout) ? saved.layout : "random",
  };
  const filters = {
    red: { league: "all", query: "" },
    blue: { league: "all", query: "" },
  };
  let active = "red";               // the corner the arrow keys drive

  // ---------------------------------------------------------------- previews
  // One small WebGL stage per canvas, all ticked by one animation loop.
  const stages = new Map();         // canvas id -> stage
  function stageFor(canvasId, opts) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    let s = stages.get(canvasId);
    if (!s || s.canvas !== canvas) {
      s?.stage.dispose();
      s = { canvas, stage: makePreviewStage(canvas, getMats(), opts) };
      stages.set(canvasId, s);
    }
    return s.stage;
  }
  /** Put a robot def on a canvas's turntable - any def, so the workshop can show a draft. */
  function showDef(canvasId, def, opts, conditions = null) {
    const stage = stageFor(canvasId, opts);
    if (!stage) return null;
    const units = [assembleRobot(reg, def)];
    if (def.partner) units.push(assemblePartner(reg, def));
    // The damage it is carrying, per unit (the pit, scouting).
    if (conditions) units.forEach((u, i) => Object.assign(u.condition, conditions[i] || {}));
    stage.show(units);
    return stage;
  }
  function showBot(canvasId, id, conditions = null) { showDef(canvasId, reg.robot(id), undefined, conditions); }
  function dropStages() {
    for (const s of stages.values()) s.stage.dispose();
    stages.clear();
  }
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const s of stages.values()) if (s.canvas.isConnected !== false) s.stage.tick(dt);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------------------------------------------------------------- routing
  // A screen and, for the career, the part of it: #career/workshop, #career/pit.
  const screens = { main: mainScreen, quick: quickScreen, settings: settingsScreen, credits: creditsScreen, career: careerScreen, halloffame: hallScreen, tournament: tournamentScreen };
  const where = () => { const [name, sub = ""] = location.hash.replace(/^#/, "").split("/"); return { name: name || "main", sub }; };
  function route() {
    const { name, sub } = where();
    dropStages();
    (screens[name] || mainScreen)(sub);
    // Every screen opens at its top (the phone build scrolls them as pages).
    if (typeof scrollTo === "function") scrollTo(0, 0);
  }
  // The back and forward arrows (nav.js): every screen is a history entry.
  const nav = makeNav(app);
  addEventListener("hashchange", () => { nav.sync(); route(); });
  /** Open a screen: a new history entry, drawn straight away. */
  const go = (name) => {
    nav.push(name === "main" ? "" : `#${name}`);
    route();
  };

  addEventListener("keydown", (e) => {
    const screen = where().name;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target?.tagName);
    // Alt + arrows: the back and forward arrows, from anywhere.
    if (e.altKey && !typing && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      if (e.key === "ArrowLeft") nav.back(); else nav.forward();
      return;
    }
    if (typing && e.key !== "Escape" && ((e.target.tagName !== "INPUT") || (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter"))) return;
    // The career's own screens (the workshop) step back to the hub first.
    if (e.key === "Escape" && screen === "career" && careerUi.back()) { e.preventDefault(); return; }
    if (e.key === "Escape" && screen !== "main") { e.preventDefault(); go("main"); return; }
    if (screen === "main") mainKeys(e);
    else if (screen === "quick") quickKeys(e);
    else if (screen === "career") careerUi.keys(e);
    else if (screen === "tournament") tournamentUi.keys(e);
  });

  // ---------------------------------------------------------------- main menu
  let menuIndex = 1;                // Quick Fight - the one that works
  const MENU = [
    { id: "career", title: "Career", desc: "Climb four leagues, chase the Giant Nut, keep the lights on." },
    { id: "quick", title: "Quick Fight", desc: "Pick any two robots in the field and put them in the box. Two players on one keyboard, too." },
    { id: "tournament", title: "Tournament", desc: "A one-off knockout, groups or the Giant Nut - for you, your friends, or the AI." },
    { id: "halloffame", title: "Hall of Fame", desc: "Retired careers, legendary robots and the all-time records." },
    { id: "settings", title: "Settings", desc: "Difficulty, graphics, display and controls." },
    { id: "credits", title: "Credits", desc: "Who made this, and with what." },
  ];
  function mainScreen() {
    const featured = entries.filter((e) => e.league !== "exhibition" && !e.isPlayer);
    const feat = featured[Math.floor((Date.now() / 8000) % featured.length)];
    app.innerHTML = `
      <div class="screen main">
        <div class="main-left">
          <div class="logo big">ROBO<span>LEAGUE</span></div>
          <div class="tagline">Heavyweight combat robotics · 250 lb · three minutes</div>
          <nav class="menu-items" id="menu-items">
            ${MENU.map((m, i) => `
              <button class="menu-item${i === menuIndex ? " sel" : ""}${m.soon ? " soon" : ""}" data-go="${m.id}" data-i="${i}">
                <span class="mi-title">${m.title}</span>
                <span class="mi-desc">${m.desc}</span>
                ${m.soon ? `<span class="badge">coming soon</span>` : ""}
              </button>`).join("")}
          </nav>
          <div class="hint">↑ ↓ to choose · Enter to select</div>
        </div>
        <div class="main-right">
          <canvas class="stage" id="feat-canvas"></canvas>
          <div class="feat-caption">
            <div class="feat-label">In the field</div>
            <div class="feat-name">${esc(feat.name)}</div>
            <div class="feat-meta">${esc(LEAGUE_NAMES[feat.league])} · ${esc(feat.team)}</div>
          </div>
        </div>
      </div>`;
    app.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
    app.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("mouseenter", () => setMenu(Number(b.dataset.i))));
    showBot("feat-canvas", feat.id);
  }
  function setMenu(i) {
    menuIndex = (i + MENU.length) % MENU.length;
    app.querySelectorAll("[data-i]").forEach((b) => b.classList.toggle("sel", Number(b.dataset.i) === menuIndex));
  }
  function mainKeys(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setMenu(menuIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setMenu(menuIndex - 1); }
    else if (e.key === "Enter") { e.preventDefault(); go(MENU[menuIndex].id); }
  }

  // ---------------------------------------------------------------- quick fight
  function quickScreen() {
    app.innerHTML = `
      <div class="screen quick">
        <header class="bar">
          <button class="back" data-go="main">Menu</button>
          <div class="bar-title">Quick Fight</div>
          <div class="bar-hint">← → corner · ↑ ↓ robot · Enter fight · Esc back</div>
        </header>
        <div class="qf">
          ${CORNERS.map((c) => cornerHtml(c)).join(`
          <div class="vs">
            <div class="vs-text">VS</div>
            <button class="fight" id="fight">FIGHT!</button>
            <button class="ghost" id="random">Random matchup</button>
            <button class="ghost" id="swap">Swap corners</button>
            <div class="qf-where">
              <label>Venue<select id="qf-venue">${venueIds(reg).map((id) => `<option value="${id}"${id === pick.venue ? " selected" : ""}>${esc(venueOf(reg, id).name)}</option>`).join("")}</select></label>
              <label>Layout<select id="qf-layout"><option value="random"${pick.layout === "random" ? " selected" : ""}>Random</option>${layoutIds(reg).map((id) => `<option value="${id}"${id === pick.layout ? " selected" : ""}>${esc(layoutOf(reg, id).name)}</option>`).join("")}</select></label>
              <div class="qf-blurb" id="qf-blurb"></div>
              <div class="qf-blurb qf-p2" id="qf-p2"></div>
            </div>
          </div>`)}
        </div>
      </div>`;
    app.querySelector("[data-go]").addEventListener("click", () => go("main"));
    document.getElementById("fight").addEventListener("click", startFight);
    document.getElementById("random").addEventListener("click", () => {
      const field = entries.filter((e) => e.league !== "exhibition");
      for (const c of CORNERS) choose(c, field[Math.floor(Math.random() * field.length)].id, true);
    });
    const blurb = () => {
      const el = document.getElementById("qf-blurb");
      if (!el) return;
      const v = venueOf(reg, pick.venue), l = layoutOf(reg, pick.layout);
      el.textContent = `${v?.tagline ?? ""}${l ? ` — ${l.blurb}` : " — a layout from this venue's rotation."}`;
    };
    for (const [id, key] of [["qf-venue", "venue"], ["qf-layout", "layout"]]) {
      document.getElementById(id)?.addEventListener("change", (e) => { pick[key] = e.target.value; savePicks(pick); blurb(); });
    }
    blurb();
    document.getElementById("swap").addEventListener("click", () => {
      const r = pick.red;
      choose("red", pick.blue, true);
      choose("blue", r, true);
    });
    for (const c of CORNERS) {
      const search = document.getElementById(`search-${c}`);
      search.addEventListener("input", () => { filters[c].query = search.value; renderList(c); });
      search.addEventListener("focus", () => setActive(c));
      document.getElementById(`chips-${c}`).querySelectorAll("[data-league]").forEach((b) => b.addEventListener("click", () => {
        filters[c].league = b.dataset.league;
        document.getElementById(`chips-${c}`).querySelectorAll("[data-league]").forEach((x) => x.classList.toggle("on", x === b));
        renderList(c);
        setActive(c);
      }));
      document.getElementById(`corner-${c}`).addEventListener("mousedown", () => setActive(c));
      renderList(c);
      renderCard(c);
      showBot(`stage-${c}`, pick[c]);
    }
    document.querySelectorAll("[data-driver]").forEach((b) => b.addEventListener("click", () => {
      pick.driver = b.dataset.driver;
      savePicks(pick);
      document.querySelectorAll("[data-driver]").forEach((x) => x.classList.toggle("on", x.dataset.driver === pick.driver));
      p2Note();
    }));
    document.querySelectorAll("[data-bluedriver]").forEach((b) => b.addEventListener("click", () => {
      pick.blueDriver = b.dataset.bluedriver;
      savePicks(pick);
      document.querySelectorAll("[data-bluedriver]").forEach((x) => x.classList.toggle("on", x.dataset.bluedriver === pick.blueDriver));
      p2Note();
    }));
    p2Note();
    setActive(active);
  }

  function cornerHtml(c) {
    const driver = c === "red"
      ? `<div class="driver">Driver
           <button class="seg${pick.driver === "you" ? " on" : ""}" data-driver="you">You</button>
           <button class="seg${pick.driver === "ai" ? " on" : ""}" data-driver="ai">AI</button>
         </div>`
      : `<div class="driver">Driver
           <button class="seg${pick.blueDriver === "ai" ? " on" : ""}" data-bluedriver="ai">AI</button>
           <button class="seg${pick.blueDriver === "p2" ? " on" : ""}" data-bluedriver="p2" title="Two players on one keyboard: red on W A S D + Space, blue on the arrows + Right Shift">Player 2</button>
         </div>`;
    return `
      <section class="corner ${c}" id="corner-${c}">
        <div class="corner-head"><span class="corner-name">${c === "red" ? "Red" : "Blue"} corner</span>${driver}</div>
        <div class="show">
          <canvas class="stage" id="stage-${c}"></canvas>
          <div class="card" id="card-${c}"></div>
        </div>
        <div class="picker">
          <input class="search" id="search-${c}" type="search" placeholder="Search robots, teams, weapons" autocomplete="off" value="${esc(filters[c].query)}">
          <div class="chips" id="chips-${c}">
            ${LEAGUE_CHIPS.map(([id, label]) => `<button class="chip${filters[c].league === id ? " on" : ""}" data-league="${id}">${label}</button>`).join("")}
          </div>
          <ul class="list" id="list-${c}"></ul>
        </div>
      </section>`;
  }

  function renderList(c) {
    const list = document.getElementById(`list-${c}`);
    if (!list) return;
    const shown = filterCatalog(entries, filters[c]);
    let letter = "";
    const rows = [];
    for (const e of shown) {
      const L = e.name[0].toUpperCase();
      const head = /[A-Z]/.test(L) ? L : "#";
      if (head !== letter) { letter = head; rows.push(`<li class="letter">${head}</li>`); }
      rows.push(`<li class="row${e.id === pick[c] ? " sel" : ""}" data-id="${e.id}">
        <span class="sw" style="background:${esc(e.livery.primary || "#888")};border-color:${esc(e.livery.accent || "#444")}"></span>
        <span class="nm">${esc(e.name)}${e.isPlayer ? ` <em>yours</em>` : ""}</span>
        <span class="lg lg-${e.league}">${e.league === "exhibition" ? "exh" : e.league}</span>
      </li>`);
    }
    list.innerHTML = rows.join("") || `<li class="empty">No robots match.</li>`;
    list.querySelectorAll("[data-id]").forEach((li) => li.addEventListener("click", () => { setActive(c); choose(c, li.dataset.id); }));
    scrollToPick(c);
  }

  function choose(c, id, rerenderList = false) {
    if (!byId.has(id)) return;
    pick[c] = id;
    savePicks(pick);
    const list = document.getElementById(`list-${c}`);
    if (rerenderList || !list) renderList(c);
    else list.querySelectorAll("[data-id]").forEach((li) => li.classList.toggle("sel", li.dataset.id === id));
    scrollToPick(c);
    renderCard(c);
    showBot(`stage-${c}`, id);
  }

  /** Bring the pick into view in its list - the list only, never the page (on a phone the page scrolls too). */
  function scrollToPick(c) {
    const list = document.getElementById(`list-${c}`);
    const li = list?.querySelector(`[data-id="${pick[c]}"]`);
    if (!li?.getBoundingClientRect || !list.getBoundingClientRect) return;
    const lr = list.getBoundingClientRect(), r = li.getBoundingClientRect();
    if (r.top < lr.top) list.scrollTop += r.top - lr.top;
    else if (r.bottom > lr.bottom) list.scrollTop += r.bottom - lr.bottom;
  }

  function renderCard(c) {
    const el = document.getElementById(`card-${c}`);
    if (!el) return;
    const s = specCard(reg, pick[c]);
    const bits = [
      ["Weapon", `${s.weaponClass}`],
      ["Weight", `${s.weightLb} lb`],
      ["Top speed", `${s.topSpeedMph} mph`],
      ["Armour", `${s.armourHp} hp`],
      ["Push", `${s.pushRatio}×`],
      ...(s.weaponEnergyKJ ? [["Energy", `${s.weaponEnergyKJ} kJ`]] : []),
    ];
    const tags = [
      s.invertible && "Invertible",
      s.selfRights && "Self-rights",
      s.partner && `Multibot + ${esc(s.partner.name)}`,
    ].filter(Boolean);
    el.innerHTML = `
      <div class="card-name">${esc(s.name)}</div>
      <div class="card-meta">${esc(s.league)}${s.team ? ` · ${esc(s.team)}` : ""}${s.rating != null ? ` · driver ${s.rating}` : ""}</div>
      <div class="card-weapon">${esc(s.weapon)}</div>
      <div class="card-stats">${bits.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
      ${tags.length ? `<div class="card-tags">${tags.map((t) => `<span>${t}</span>`).join("")}</div>` : ""}
      ${s.inspiredBy ? `<div class="card-nod">a nod to ${esc(s.inspiredBy)}</div>` : ""}`;
  }

  function setActive(c) {
    active = c;
    for (const k of CORNERS) document.getElementById(`corner-${k}`)?.classList.toggle("active", k === c);
  }

  function quickKeys(e) {
    if (e.key === "ArrowLeft" && e.target?.tagName !== "INPUT") { e.preventDefault(); setActive("red"); }
    else if (e.key === "ArrowRight" && e.target?.tagName !== "INPUT") { e.preventDefault(); setActive("blue"); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const shown = filterCatalog(entries, filters[active]);
      if (!shown.length) return;
      const i = shown.findIndex((x) => x.id === pick[active]);
      const next = i < 0 ? 0 : (i + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      choose(active, shown[next].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      startFight();
    }
  }

  /** Under the FIGHT button: who drives what, when a second player is in. */
  function p2Note() {
    const el = document.getElementById("qf-p2");
    if (!el) return;
    el.innerHTML = pick.blueDriver !== "p2" ? ""
      : pick.driver === "you" ? `<b>Two players, one keyboard.</b> Red: W A S D, Space weapon, Left Shift brake. Blue: arrows, Right Shift or / weapon, . brake.`
      : `<b>You drive blue</b> (arrows or W A S D, Space weapon); the AI drives red.`;
  }

  function startFight() {
    savePicks(pick);
    const q = new URLSearchParams({ red: pick.red, blue: pick.blue, driver: pick.driver, venue: pick.venue, layout: pick.layout });
    if (pick.blueDriver === "p2") q.set("p2", "1");
    location.href = `fight.html?${q.toString()}`;
  }

  // ---------------------------------------------------------------- the rest
  function placeholder(title, body) {
    app.innerHTML = `
      <div class="screen page">
        <header class="bar">
          <button class="back" data-go="main">Menu</button>
          <div class="bar-title">${title}</div>
          <div class="bar-hint">Esc back</div>
        </header>
        <div class="page-body">${body}</div>
      </div>`;
    app.querySelector("[data-go]").addEventListener("click", () => go("main"));
  }

  const careerUi = makeCareerUi({ app, reg, go, esc, showBot, showDef });
  function careerScreen(sub) { careerUi.open(sub); }
  const tournamentUi = makeTournamentUi({ app, reg, go, esc, showDef });
  function tournamentScreen() { tournamentUi.show(); }

  // ---------------------------------------------------------------- hall of fame (Stage 7)
  function hallScreen() {
    let hall;
    try { hall = loadHall(localStorage.getItem(HALL_KEY)); } catch { hall = loadHall(null); }
    const money = (n) => `$${Math.round(n).toLocaleString()}`;
    const fmtS = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
    const rec = hall.records || {};
    const recRow = (label, r, fmt = (v) => v) => (r ? `<tr><td>${label}</td><td><b>${esc(fmt(r.value))}</b></td><td class="muted">${esc(r.team)}</td></tr>` : "");
    const body = hall.careers.length ? `
      <div class="hof">
        <section class="hof-col">
          <div class="scout-sub">Retired careers</div>
          ${hall.careers.map((c, i) => `
            <div class="panel hof-card">
              <div class="hof-rank">#${i + 1}</div>
              <div class="hof-team">${esc(c.team)}</div>
              <div class="muted small">${c.seasons} season${c.seasons > 1 ? "s" : ""} · ${c.record.wins}-${c.record.losses}${c.record.kos ? `, ${c.record.kos} KO` : ""} · best: ${esc(LEAGUE_NAMES[c.best.league] || c.best.league)}${c.best.giantNut ? ` · Giant Nut: ${esc(c.best.giantNut)}` : ""} · earned ${money(c.earned)}</div>
              ${c.giantNuts ? `<div class="hof-gn">🔩 ${c.giantNuts} Giant Nut${c.giantNuts > 1 ? "s" : ""}</div>` : ""}
              ${c.titles.length ? `<ul class="trophies">${c.titles.map((t) => `<li>🏆 ${esc(t.title)} <span class="muted">S${t.season}${t.robot ? ` · ${esc(t.robot)}` : ""}</span></li>`).join("")}</ul>` : ""}
              <div class="hof-robots">${c.robots.map((r) => `<span class="chip">${esc(r.name)} v${esc(r.version)} · ${r.wins}-${r.fights - r.wins}</span>`).join(" ")}</div>
              ${c.nemesis ? `<div class="muted small">Nemesis: <b>${esc(c.nemesis.name)}</b> · ${c.nemesis.w}-${c.nemesis.l} in ${c.nemesis.fights} meetings</div>` : ""}
            </div>`).join("")}
        </section>
        <section class="hof-col">
          <div class="scout-sub">Records</div>
          <table class="ledger">
            ${recRow("Most titles", rec.mostTitles)}${recRow("Most Giant Nuts", rec.mostGiantNuts)}${recRow("Most wins", rec.mostWins)}
            ${recRow("Longest win streak", rec.bestStreak)}${recRow("Fastest KO", rec.fastestKoS, fmtS)}
            ${recRow("Most damage in a fight", rec.mostDamage)}${recRow("Longest career", rec.longestCareer, (v) => `${v} seasons`)}
          </table>
          <div class="scout-sub">Legends of the field</div>
          ${hall.legends.length ? `<table class="ledger">${hall.legends.map((l) => `<tr><td><b>${esc(l.name)}</b>${l.inspiredBy ? ` <span class="muted small">a nod to ${esc(l.inspiredBy)}</span>` : ""}</td>
            <td class="muted">${l.worldTitles ? `${l.worldTitles}x World` : ""}${l.worldTitles && l.giantNuts ? " · " : ""}${l.giantNuts ? `${l.giantNuts}x Giant Nut` : ""}</td><td class="muted small">in ${esc(l.era)}'s era</td></tr>`).join("")}</table>`
            : `<p class="muted">An AI robot becomes a legend with three World titles, two Giant Nuts, or two Worlds and a Giant Nut in one career.</p>`}
        </section>
      </div>` : `
      <div class="soon-card">
        <h2>The Hall of Fame is empty</h2>
        <p>Retire from a career (Career → Trophies) and your team goes in here, with every robot it built,
          its titles and its records - and the AI robots that became legends while you were racing.</p>
      </div>`;
    placeholder("Hall of Fame", body);
  }

  function settingsScreen() {
    placeholder("Settings", `<div class="settings-page"><div id="saves-body"></div><div id="settings-body"></div></div>`);
    renderSettings(document.getElementById("settings-body"), {
      note: "Saved on this computer. Change them here, in your career (Settings tab), or in a fight (Esc).",
    });
    // Export and import: the career, the Hall of Fame, a tournament and these settings.
    renderSaves(document.getElementById("saves-body"), {
      onImported: () => { careerUi.reload(); tournamentUi.reload(); settingsScreen(); },
    });
  }

  function creditsScreen() {
    placeholder("Credits", `
      <div class="credits">
        <div class="logo">ROBO<span>LEAGUE</span></div>
        <div class="cr-group"><div class="cr-role">Game design &amp; direction</div><div class="cr-name">Collin</div></div>
        <div class="cr-group"><div class="cr-role">Programming</div><div class="cr-name">Built with Claude Code</div></div>
        <div class="cr-group"><div class="cr-role">Rendering</div><div class="cr-name">Three.js</div></div>
        <div class="cr-group"><div class="cr-role">Physics</div><div class="cr-name">Rapier, by Dimforge</div></div>
        <div class="cr-group"><div class="cr-role">The field</div><div class="cr-name">${reg.roster().length} robots - ${entries.filter((e) => e.origin === "parody").length} parodies, ${entries.filter((e) => e.origin === "original" && e.league !== "exhibition").length} originals</div></div>
        <p class="muted small">Inspired by the sport of robot combat. Parody robots are affectionate nods with their own names
        and designs; this game is not affiliated with BattleBots or any team.</p>
      </div>`);
  }

  window.__MENU_BOOTED__ = true;
  window.ROBO_MENU = { reg, entries, pick, filters, go, nav, choose, startFight, stages, careerUi, tournamentUi };
  route();
}

// ---------------------------------------------------------------- storage
// Per-browser convenience only: the last matchup picked.
function loadPicks() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function savePicks(p) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ red: p.red, blue: p.blue, driver: p.driver, blueDriver: p.blueDriver, venue: p.venue, layout: p.layout })); } catch { /* private mode */ }
}
