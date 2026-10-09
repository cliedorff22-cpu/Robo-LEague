// tournament_ui.js - the Tournament screens: setting one up, and the hub that
// runs it (the next fight, the bracket, the groups, the results).
//
// All the rules are js/logic/cup.js; this file only shows the cup and calls
// into it. The cup is saved to localStorage after everything that changes
// it. A fight in the arena is handed over like a career fight: FIGHT_KEY
// says which fight and opens fight.html?tourney=1; the arena writes RESULT_KEY
// back when the bell goes, and the hub picks it up the next time it is shown.

import {
  makeCup, advanceCup, nextCupFight, recordCupResult, simulateCupFight, cupTables, cupRanking, cupArena, cupStageLabel,
  humanOf, serializeCup, deserializeCup, registerCupRobots, cupConfig, cupDef, cupSeed,
} from "../logic/cup.js";
import { roundName } from "../logic/tournament.js";
import { catalog, LEAGUE_NAMES } from "../logic/catalog.js";
import { venueIds, venueOf, layoutIds, layoutOf } from "../logic/arenas.js";
import { deserialize } from "../logic/career.js";
import { playerDef } from "../logic/garage.js";
import { registerCareerRobots } from "../logic/field.js";

export const CUP_KEY = "robo-league.tournament";
export const CUP_FIGHT_KEY = "robo-league.tournament.fight";
export const CUP_RESULT_KEY = "robo-league.tournament.result";
const SETUP_KEY = "robo-league.tournament.setup";

const METHOD = { ko: "KO", tapout: "tap out", decision: "decision" };
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const TABS = [["bracket", "Bracket"], ["groups", "Groups"], ["results", "Results"], ["players", "Players"]];

export function makeTournamentUi({ app, reg, go, esc, showDef }) {
  let cup = load();
  if (cup) registerCupRobots(reg, cup);
  let tab = "bracket";
  let last = null;               // the last person's fight, shown until the next is fought
  const cfg = cupConfig(reg);
  const entries = catalog(reg).filter((e) => !e.id.startsWith("cup_custom_"));

  // The setup form, remembered between visits.
  const setup = { name: "Friday Night Cup", format: "knockout", size: 8, fill: "random", venue: "rounds", layout: "random",
    players: [{ name: "Player 1", robot: reg.playerId }], ...loadSetup() };

  function save() {
    try { localStorage.setItem(CUP_KEY, serializeCup(cup)); } catch (e) { console.error("[tournament] save failed", e); }
  }
  const saveSetup = () => { try { localStorage.setItem(SETUP_KEY, JSON.stringify(setup)); } catch { /* private mode */ } };

  const nameOf = (id) => cupDef(reg, cup, id).name;
  /** "Ann (Hex Physician)" for a person's robot, the robot's name otherwise. */
  const who = (id) => {
    const h = humanOf(cup, id);
    return h != null ? `${esc(cup.players[h].name)} <span class="muted">(${esc(nameOf(id))})</span>` : esc(nameOf(id));
  };

  /** The player's career robot, if there is a career on this computer. */
  function careerRobot() {
    try {
      const text = localStorage.getItem("robo-league.career");
      if (!text) return null;
      const c = deserialize(text);
      registerCareerRobots(reg, c);
      const d = playerDef(reg, c);
      return { name: d.name, body: d.body, build: d.build, livery: d.livery, personality: d.personality, archetype: d.archetype, partner: d.partner || undefined, rating: d.rating, schema: d.schema, number: d.number, origin: "original", league: c.membership[c.playerId] };
    } catch { return null; }
  }

  /** Pick up a fight result the arena left for us, if it is for the fight waiting. */
  function collectResult() {
    let handed;
    try { handed = JSON.parse(localStorage.getItem(CUP_RESULT_KEY) || "null"); } catch { handed = null; }
    if (!handed || !cup) return;
    localStorage.removeItem(CUP_RESULT_KEY);
    localStorage.removeItem(CUP_FIGHT_KEY);
    const f = nextCupFight(cup);
    if (!f || f.id !== handed.fixtureId) return;
    recordCupResult(reg, cup, f.id, handed.result);
    last = { f, result: handed.result };
    save();
  }

  function show() {
    if (!cup) return setupView();
    collectResult();
    advanceCup(reg, cup);
    save();
    hub();
  }

  // ---------------------------------------------------------------- setup

  function robotOptions(selected, mine) {
    const byLeague = ["world", "elite", "pro", "rookie", "exhibition"].map((lg) => [lg, entries.filter((e) => e.league === lg)]);
    return `${mine ? `<optgroup label="Your career"><option value="career"${selected === "career" ? " selected" : ""}>${esc(mine.name)} - your career robot</option></optgroup>` : ""}
      ${byLeague.map(([lg, list]) => `<optgroup label="${esc(LEAGUE_NAMES[lg])}">${list.map((e) => `<option value="${e.id}"${e.id === selected ? " selected" : ""}>${esc(e.name)}</option>`).join("")}</optgroup>`).join("")}`;
  }

  function setupView() {
    const fmtDef = cfg.formats.find((f) => f.id === setup.format) || cfg.formats[0];
    if (!fmtDef.sizes.includes(setup.size)) setup.size = fmtDef.sizes.find((n) => n >= setup.players.length) ?? fmtDef.sizes[0];
    const mine = careerRobot();
    const fills = [["random", "Random from the field"], ["top", "The best-rated"], ...reg.league.leagues.slice().reverse().map((lg) => [lg, `${LEAGUE_NAMES[lg]} first`])];
    app.innerHTML = `
      <div class="screen page">
        <header class="bar"><button class="back" data-go="main">Menu</button><div class="bar-title">Tournament</div><div class="bar-hint">Esc back</div></header>
        <div class="page-body tn-setup">
          <div class="tn-col">
            <h2>A one-off tournament</h2>
            <p class="muted">Outside the career: no money, no damage carried - every robot is repaired between fights. Enter yourself, your friends, or nobody and watch it run.</p>
            <label class="cn-field">Name <input id="tn-name" maxlength="40" value="${esc(setup.name)}"></label>
            <div class="cn-label">Format</div>
            <div class="cn-choices">${cfg.formats.map((f) => `<button class="cn-choice${f.id === setup.format ? " on" : ""}" data-format="${f.id}"><b>${esc(f.name)}</b>${esc(f.blurb)}</button>`).join("")}</div>
            ${fmtDef.sizes.length > 1 ? `<div class="cn-label">Robots</div>
            <div class="cn-choices">${fmtDef.sizes.map((n) => `<button class="cn-choice${n === setup.size ? " on" : ""}" data-size="${n}"><b>${n}</b></button>`).join("")}</div>` : ""}
            ${setup.format !== "giantNut" ? `<div class="cn-label">The rest of the field</div>
            <div class="cn-choices">${fills.map(([id, label]) => `<button class="cn-choice${id === setup.fill ? " on" : ""}" data-fill="${id}"><b>${esc(label)}</b></button>`).join("")}</div>` : ""}
            <div class="cn-label">Where</div>
            <div class="tn-where">
              <label>Venue <select id="tn-venue"><option value="rounds"${setup.venue === "rounds" ? " selected" : ""}>Up the venues, round by round</option>${venueIds(reg).map((id) => `<option value="${id}"${id === setup.venue ? " selected" : ""}>${esc(venueOf(reg, id).name)}</option>`).join("")}</select></label>
              <label>Layout <select id="tn-layout"><option value="random"${setup.layout === "random" ? " selected" : ""}>From the venue's rotation</option>${layoutIds(reg).map((id) => `<option value="${id}"${id === setup.layout ? " selected" : ""}>${esc(layoutOf(reg, id).name)}</option>`).join("")}</select></label>
            </div>
          </div>
          <div class="tn-col">
            <div class="cn-label">People (${setup.players.length})</div>
            <div class="tn-players">${setup.players.map((p, i) => `
              <div class="tn-player">
                <input class="tn-pname" data-pname="${i}" maxlength="20" value="${esc(p.name)}" aria-label="Player ${i + 1}'s name">
                <select data-probot="${i}" aria-label="Player ${i + 1}'s robot">${robotOptions(p.robot, mine)}</select>
                <button class="ghost tiny" data-premove="${i}" aria-label="Remove player ${i + 1}">✕</button>
              </div>`).join("") || `<p class="muted">Nobody: the AI fights every fight and you watch the bracket fill.</p>`}</div>
            ${setup.players.length < cfg.maxPlayers ? `<button class="ghost" id="tn-addplayer">+ Add a person</button>` : ""}
            <p class="muted small">When two people meet, they share the keyboard: red on W A S D and Space, blue on the arrows and Right Shift. A person can also hand any fight to the AI.</p>
            <div class="tn-error neg small" id="tn-error"></div>
            <button class="fight" id="tn-start">Start the tournament</button>
          </div>
        </div>
      </div>`;
    app.querySelector("[data-go]").addEventListener("click", () => go("main"));
    const read = () => {
      setup.name = document.getElementById("tn-name")?.value ?? setup.name;
      app.querySelectorAll("[data-pname]").forEach((el) => { setup.players[Number(el.dataset.pname)].name = el.value; });
      setup.venue = document.getElementById("tn-venue")?.value ?? setup.venue;
      setup.layout = document.getElementById("tn-layout")?.value ?? setup.layout;
      saveSetup();
    };
    const pickOn = (attr, key, cast = (x) => x) => app.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener("click", () => { read(); setup[key] = cast(b.dataset[attr]); saveSetup(); setupView(); }));
    pickOn("format", "format");
    pickOn("size", "size", Number);
    pickOn("fill", "fill");
    app.querySelectorAll("[data-probot]").forEach((el) => el.addEventListener("change", () => { setup.players[Number(el.dataset.probot)].robot = el.value; saveSetup(); }));
    app.querySelectorAll("[data-premove]").forEach((b) => b.addEventListener("click", () => { read(); setup.players.splice(Number(b.dataset.premove), 1); saveSetup(); setupView(); }));
    document.getElementById("tn-addplayer")?.addEventListener("click", () => { read(); actions.addPlayer(); });
    for (const id of ["tn-name", "tn-venue", "tn-layout"]) document.getElementById(id)?.addEventListener("change", read);
    document.getElementById("tn-start").addEventListener("click", () => { read(); actions.start(); });
  }

  // ---------------------------------------------------------------- actions (the headless check drives these)

  const actions = {
    addPlayer(robot = null) {
      const used = new Set(setup.players.map((p) => p.robot));
      const free = entries.find((e) => e.league !== "exhibition" && !used.has(e.id));
      setup.players.push({ name: `Player ${setup.players.length + 1}`, robot: robot || free?.id });
      saveSetup();
      if (!cup) setupView();
    },
    /** Start the cup from the setup form (or `over` it). */
    start(over = {}, seed = (Date.now() & 0x7fffffff) || 1) {
      Object.assign(setup, over);
      const err = document.getElementById("tn-error");
      try {
        const mine = setup.players.some((p) => p.robot === "career") ? careerRobot() : null;
        const players = setup.players.map((p) => (p.robot === "career" ? { name: p.name, def: mine } : { name: p.name, robot: p.robot }));
        cup = makeCup(reg, { ...setup, players, seed });
      } catch (e) {
        if (err) err.textContent = String(e.message || e);
        return { ok: false, reason: String(e.message || e) };
      }
      registerCupRobots(reg, cup);
      last = null;
      tab = cup.groups ? "groups" : "bracket";
      advanceCup(reg, cup);
      save();
      hub();
      return { ok: true };
    },
    fight() { const f = nextCupFight(cup); if (f) arenaFight(f); },
    simulate() {
      const f = nextCupFight(cup);
      if (!f) return null;
      const result = simulateCupFight(reg, cup, f.id);
      last = { f, result };
      save(); hub();
      return result;
    },
    tab(id) { tab = id; hub(); },
    abandon() { cup = null; last = null; localStorage.removeItem(CUP_KEY); setupView(); },
  };

  function arenaFight(f) {
    save();
    const arena = cupArena(reg, cup, f);
    const ha = humanOf(cup, f.a), hb = humanOf(cup, f.b);
    localStorage.setItem(CUP_FIGHT_KEY, JSON.stringify({
      fixtureId: f.id, red: f.a, blue: f.b, at: Date.now(),
      names: { red: ha != null ? cup.players[ha].name : null, blue: hb != null ? cup.players[hb].name : null },
      // People's own robots are not in the data files: the arena registers them.
      custom: Object.fromEntries([f.a, f.b].filter((id) => cup.custom?.[id]).map((id) => [id, cup.custom[id]])),
      stage: `${cup.name} · ${cupStageLabel(cup, f)}`,
    }));
    localStorage.removeItem(CUP_RESULT_KEY);
    const q = new URLSearchParams({
      red: f.a, blue: f.b, driver: ha != null ? "you" : "ai", seed: String(cupSeed(cup, f) & 0xffff),
      venue: arena.venue, layout: arena.layout, tourney: "1",
    });
    if (hb != null) q.set("p2", "1");
    location.href = `fight.html?${q}`;
  }

  // ---------------------------------------------------------------- the hub

  function hub() {
    const f = cup.done ? null : nextCupFight(cup);
    const fmtDef = cfg.formats.find((x) => x.id === cup.format);
    const roundLabel = cup.done ? "finished" : cup.round < cup.groupRounds ? `group round ${cup.round + 1} of ${cup.groupRounds}` : roundName(cup.bracket, cup.round - cup.groupRounds).toLowerCase();
    app.innerHTML = `
      <div class="screen career tourney">
        <header class="bar"><button class="back" data-go="main">Menu</button><div class="bar-title">Tournament · ${esc(cup.name)}</div><div class="bar-hint">${esc(fmtDef?.name || "")} · ${cup.entrants.length} robots · ${esc(roundLabel)}</div></header>
        <div class="cr-main">
          <section class="cr-left">
            ${last ? lastHtml() : ""}
            ${cup.done ? championHtml() : f ? nextHtml(f) : `<div class="panel">Waiting on the other fights...</div>`}
            <div class="next-actions"><button class="ghost tiny" id="tn-abandon">${cup.done ? "New tournament" : "Abandon the tournament"}</button></div>
          </section>
          <section class="cr-right">
            <div class="tabs">${TABS.filter(([id]) => id !== "groups" || cup.groups).map(([id, label]) => `<button class="tab${tab === id ? " on" : ""}" data-tab="${id}">${label}</button>`).join("")}</div>
            <div class="tab-body">${tabHtml()}</div>
          </section>
        </div>
      </div>`;
    app.querySelector("[data-go]").addEventListener("click", () => go("main"));
    app.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => actions.tab(b.dataset.tab)));
    document.getElementById("tn-fight")?.addEventListener("click", () => actions.fight());
    document.getElementById("tn-sim")?.addEventListener("click", () => actions.simulate());
    document.getElementById("tn-abandon")?.addEventListener("click", () => {
      if (cup.done || confirm("Abandon this tournament? It cannot be finished later.")) actions.abandon();
    });
    if (f) { showDef("tn-red", cupDef(reg, cup, f.a)); showDef("tn-blue", cupDef(reg, cup, f.b)); }
    else if (cup.done) showDef("tn-red", cupDef(reg, cup, cup.champion));
  }

  function nextHtml(f) {
    const arena = cupArena(reg, cup, f);
    const ha = humanOf(cup, f.a), hb = humanOf(cup, f.b);
    const drivers = ha != null && hb != null ? `${esc(cup.players[ha].name)} (red: W A S D, Space) against ${esc(cup.players[hb].name)} (blue: arrows, Right Shift) on one keyboard.`
      : `${esc(cup.players[ha ?? hb].name)} drives ${ha != null ? "red" : "blue"}; the AI drives the other corner.`;
    return `
      <div class="panel next">
        <div class="next-stage">${esc(cupStageLabel(cup, f))} <span class="next-where">· ${esc(venueOf(reg, arena.venue)?.name ?? "")} · ${esc(layoutOf(reg, arena.layout)?.name ?? "")}</span></div>
        <div class="next-vs"><span class="me">${who(f.a)}</span> <span class="vs-small">vs</span> <span class="them">${who(f.b)}</span></div>
        <div class="tn-pair"><canvas class="stage" id="tn-red"></canvas><canvas class="stage" id="tn-blue"></canvas></div>
        <p class="small">${drivers}</p>
        <div class="next-actions">
          <button class="fight" id="tn-fight">FIGHT!</button>
          <button class="ghost" id="tn-sim">Let the AI fight it</button>
        </div>
      </div>`;
  }

  function lastHtml() {
    const { f, result: r } = last;
    const how = r.method === "decision" ? `${r.decision === "split" ? "split" : "unanimous"} decision` : `${METHOD[r.method] || r.method} at ${fmt(r.elapsedS)}`;
    return `<div class="panel result ${humanOf(cup, r.winnerId) != null ? "won" : "lost"}">
      <div class="res-line"><b>${who(r.winnerId)}</b> beat ${who(r.winnerId === f.a ? f.b : f.a)} · ${esc(how)}${r.by === "sim" ? " · fought by the AI" : ""}</div></div>`;
  }

  function championHtml() {
    const h = humanOf(cup, cup.champion);
    const final = cup.log[cup.log.length - 1];
    return `
      <div class="panel result season-end">
        <div class="next-stage">${esc(cup.name)} is over</div>
        <div class="res-big">${h != null ? `${esc(cup.players[h].name).toUpperCase()} WINS` : "CHAMPION"}</div>
        <p class="big-name">${esc(nameOf(cup.champion))}</p>
        <canvas class="stage tn-champ" id="tn-red"></canvas>
        ${final ? `<p class="muted">The final: ${who(final.result.winnerId)} beat ${who(final.result.winnerId === final.a ? final.b : final.a)} by ${esc(METHOD[final.result.method] || final.result.method)}.</p>` : ""}
      </div>`;
  }

  function tabHtml() {
    if (tab === "groups" && cup.groups) return groupsHtml();
    if (tab === "results") return resultsHtml();
    if (tab === "players") return playersHtml();
    return bracketHtml();
  }

  function bracketHtml() {
    const b = cup.bracket;
    if (!b) return `<p class="muted">The ${cup.bracketSize}-robot bracket is drawn when the groups are done.</p>`;
    const nm = (id) => (id ? (humanOf(cup, id) != null ? `<b>${esc(nameOf(id))}</b>` : esc(nameOf(id))) : `<span class="muted">—</span>`);
    return `<div class="bracket">${b.rounds.map((ms, r) => `
      <div class="b-round"><div class="b-title">${roundName(b, r)}</div>
        ${ms.map((m) => `<div class="b-match${humanOf(cup, m.a) != null || humanOf(cup, m.b) != null ? " me" : ""}">
          <div class="${m.winner && m.winner === m.a ? "w" : ""}">${m.bye && !m.a ? "<span class=muted>bye</span>" : nm(m.a)}</div>
          <div class="${m.winner && m.winner === m.b ? "w" : ""}">${m.bye && !m.b ? "<span class=muted>bye</span>" : nm(m.b)}</div>
          ${m.result ? `<div class="b-how">${METHOD[m.result.method] || ""}${m.result.method === "decision" ? "" : ` ${fmt(m.result.elapsedS)}`}</div>` : ""}
        </div>`).join("")}
      </div>`).join("")}</div>`;
  }

  function groupsHtml() {
    const tables = cupTables(cup);
    return `<p class="muted small">Top ${cup.advance} of each group go through. Ranked by wins, then knockouts, then damage.</p>
      <div class="groups">${cup.groups.map((g) => `
        <table class="table${g.ids.some((id) => humanOf(cup, id) != null) ? " mine" : ""}">
          <tr><th colspan="2">Group ${g.name}</th><th>W</th><th>L</th><th>KO</th><th>Dmg</th></tr>
          ${tables[g.name].map((r, i) => `<tr class="${humanOf(cup, r.id) != null ? "me" : ""}${i < cup.advance ? " q" : ""}"><td>${i + 1}</td><td>${esc(nameOf(r.id))}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.kos}</td><td>${Math.round(r.damage)}</td></tr>`).join("")}
        </table>`).join("")}</div>`;
  }

  function resultsHtml() {
    const people = cup.log.filter((x) => humanOf(cup, x.a) != null || humanOf(cup, x.b) != null);
    const rest = cup.log.filter((x) => !people.includes(x)).slice(-30).reverse();
    const row = (x) => `<tr><td class="${x.result.winnerId === x.a ? "w" : ""}">${who(x.a)}</td><td class="${x.result.winnerId === x.b ? "w" : ""}">${who(x.b)}</td>
      <td class="muted">${METHOD[x.result.method] || x.result.method}${x.result.method !== "decision" ? ` ${fmt(x.result.elapsedS)}` : ""}</td><td class="muted">${esc(x.stage === "group" ? `Grp ${x.group}` : roundName(cup.bracket, x.bracketRound))}</td></tr>`;
    return `${cup.players.length ? `<div class="scout-sub">People's fights</div>${people.length ? `<table class="table wide">${people.map(row).join("")}</table>` : `<p class="muted">None yet.</p>`}` : ""}
      <div class="scout-sub">Around the tournament</div>
      ${rest.length ? `<table class="table wide">${rest.map(row).join("")}</table>` : `<p class="muted">Nothing yet.</p>`}`;
  }

  function playersHtml() {
    const rank = cupRanking(cup);
    const place = (id) => {
      if (cup.champion === id) return "champion";
      const r = rank.find((x) => x.id === id);
      if (!r || r.finish < 0) return cup.bracket ? "out in the groups" : "in the groups";
      const alive = cup.bracket && [...cup.bracket.rounds.flat()].some((m) => (m.a === id || m.b === id) && !m.winner);
      return alive ? `in the ${roundName(cup.bracket, r.finish).toLowerCase()}` : `out in the ${roundName(cup.bracket, Math.max(0, r.finish)).toLowerCase()}`;
    };
    return cup.players.length ? `<table class="ledger">${cup.players.map((p, i) => {
      const id = Object.keys(cup.humans).find((k) => cup.humans[k] === i);
      const fights = cup.log.filter((x) => x.a === id || x.b === id);
      const w = fights.filter((x) => x.result.winnerId === id).length;
      return `<tr><td><b>${esc(p.name)}</b> <span class="muted">${esc(nameOf(id))}</span></td><td class="muted">${w}-${fights.length - w}</td><td>${esc(place(id))}</td></tr>`;
    }).join("")}</table>` : `<p class="muted">No people in this one: the AI fights it all.</p>`;
  }

  return {
    show,
    actions,
    /** The save on this computer changed under us (an import): load it again. */
    reload() { cup = load(); if (cup) registerCupRobots(reg, cup); last = null; },
    keys(e) {
      if (e.key === "Enter" && document.getElementById("tn-fight")) { e.preventDefault(); document.getElementById("tn-fight").click(); }
    },
    get cup() { return cup; },
    get setup() { return setup; },
  };
}

function load() {
  try {
    const text = localStorage.getItem(CUP_KEY);
    return text ? deserializeCup(text) : null;
  } catch (e) {
    console.error("[tournament] could not load", e);
    return null;
  }
}
function loadSetup() {
  try { return JSON.parse(localStorage.getItem(SETUP_KEY) || "null") || {}; } catch { return {}; }
}
