// career_ui.js - the Career screens: new career, the hub between fights, and
// the end-of-season summary.
//
// All the rules are in js/logic/career.js; this file only shows the career
// and calls into it. The career is saved to localStorage after everything
// that changes it (the save IS the career object - see serialize()).
//
// A fight in the arena is handed over through localStorage: the hub writes
// which fixture it is (FIGHT_KEY) and opens fight.html?career=1; the arena
// writes the result back (RESULT_KEY) when the bell goes; the hub picks it up
// next time it is shown.

import {
  newCareer, advanceCareer, nextFight, simulatePlayerFight, applyPlayerResult, startNextSeason,
  serialize, deserialize, playerLeague, partsDiscount, playerGroup, recordOf, LEAGUE_TITLES, versionOf, fieldedDef,
} from "../logic/career.js";
import { groupTables } from "../logic/season.js";
import { roundName } from "../logic/tournament.js";
import { scouting } from "../logic/catalog.js";
import { garageOf, playerDef } from "../logic/garage.js";
import { makeWorkshop } from "./workshop_ui.js";
import { makePit } from "./pit_ui.js";
import { damageSummary } from "../logic/pit.js";
import { assembleRobot } from "../logic/build.js";
import { retireRobot } from "../logic/career.js";
import { induct, loadHall } from "../logic/halloffame.js";
import { registerCareerRobots, seedDrivers } from "../logic/field.js";
import { loadSettings, saveSettings, renderSettings } from "./settings_ui.js";
import { difficultyOf } from "../logic/settings.js";
import { venueOf, layoutOf } from "../logic/arenas.js";
import { marketHtml, wireMarket } from "./market_ui.js";
import { borrow, repay, buyListing, sellToTeam, sellRobot, debt } from "../logic/market.js";
import { sellPart } from "../logic/garage.js";
import { scoutReport } from "../logic/scouting.js";
import { renderSaves, pickFile, importText } from "./saves_ui.js";
import { storyline, rivalOf, levelOf, rivalsList, canAskRematch, askRematch, answerChallenge, cancelGrudge, grudgePurse } from "../logic/rivalry.js";

export const HALL_KEY = "robo-league.halloffame";

export const CAREER_KEY = "robo-league.career";
export const FIGHT_KEY = "robo-league.career.fight";
export const RESULT_KEY = "robo-league.career.result";
export const SCOUT_KEY = "robo-league.career.scout";

const TABS = [["standings", "Standings"], ["bracket", "Bracket"], ["results", "Results"], ["rivals", "Rivals"], ["money", "Money"], ["market", "Market"], ["trophies", "Trophies"], ["settings", "Settings"]];
const DIFF_BLURB = {
  easy: "Forgiving drivers who rarely adapt; bigger purses.",
  medium: "Drivers who learn and set up for you a little.",
  hard: "Sharp drivers who test their setup against you.",
  ultimate: "The best drivers in the sport, adapting every fight.",
};
const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
const METHOD = { ko: "KO", tapout: "tap out", decision: "decision" };

export function makeCareerUi({ app, reg, go, esc, showBot, showDef }) {
  let career = load();
  // Robots that joined the field during this career live in the save.
  if (career) {
    registerCareerRobots(reg, career);
    // A save from before the living field: give its drivers their careers now.
    if (!Object.keys(career.drivers || {}).length) seedDrivers(reg, career);
  }
  let tab = "standings";
  let summary = null;            // the last fight's summary, shown until dismissed
  let view = "hub";              // "hub", "workshop" or "pit" - the URL says which (open)
  let marketMsg = null;          // what the last Market action did, shown once
  const workshop = makeWorkshop({
    app, reg, esc, showDef,
    career: () => career,
    save: () => save(),
    back: () => go("career"),
  });
  const pit = makePit({
    app, reg, esc, showDef,
    career: () => career,
    save: () => save(),
    done: () => go("career"),
  });

  // The player's robot is called whatever they named it in the workshop.
  const rname = (id) => (career && id === career.playerId ? garageOf(reg, career).name : reg.robot(id).name);
  const nameOf = (id) => (id === career?.playerId ? `${rname(id)} (you)` : rname(id));
  const isMe = (id) => id === career?.playerId;

  /** The save on this computer changed under us (an import): load it again. */
  function reload() {
    career = load();
    if (career) {
      registerCareerRobots(reg, career);
      if (!Object.keys(career.drivers || {}).length) seedDrivers(reg, career);
    }
    summary = null; view = "hub";
  }

  function save() {
    try { localStorage.setItem(CAREER_KEY, serialize(career)); } catch (e) { console.error("[career] save failed", e); }
  }

  /** Pick up a fight result the arena left for us, if it is for the pending fight. */
  function collectResult() {
    let handed;
    try { handed = JSON.parse(localStorage.getItem(RESULT_KEY) || "null"); } catch { handed = null; }
    if (!handed) return;
    localStorage.removeItem(RESULT_KEY);
    localStorage.removeItem(FIGHT_KEY);
    const nf = nextFight(reg, career);
    if (!nf || nf.fixture.id !== handed.fixtureId) return;
    const mine = handed.partnerCondition ? [handed.condition, handed.partnerCondition] : handed.condition;
    summary = applyPlayerResult(reg, career, handed.fixtureId, handed.result, mine, handed.oppCondition || null, handed.oppLearned || null);
    save();
  }

  // ---------------------------------------------------------------- screens

  /** The difficulty is a setting, changeable any time: the career follows it. */
  function syncSettings() {
    const level = loadSettings().difficulty;
    if (career && career.difficulty !== level) { career.difficulty = level; career.prep = null; save(); }
  }

  function show() {
    if (!career) return newView();
    syncSettings();
    if (view === "workshop") return workshop.open();
    if (view === "pit") return pit.open();
    collectResult();
    if (!career.seasonOver) { advanceCareer(reg, career); save(); }
    hub();
  }

  function newView() {
    const me = reg.robot(reg.playerId);
    const cashCfg = reg.economy.startingCashOptions || { options: [["standard", reg.economy.startingCash, "Standard"]], customMin: 2000, customMax: 500000 };
    const cashOpts = cashCfg.options;
    app.innerHTML = `
      <div class="screen page">
        ${bar("Career", "Esc back")}
        <div class="page-body career-new">
          <div class="cn-left">
            <h2>Start in Rookie. Finish with the Giant Nut.</h2>
            <ul>
              <li>Four leagues of 30: Rookie, Pro, Elite and the World Championship. You start at the bottom.</li>
              <li>Each season: six groups of five, then a 16-robot playoff. The top four go up, the bottom four go down.</li>
              <li>Every third season is the Giant Nut: all 120 robots, ten mixed groups, a 64-robot bracket and the biggest purse in the sport.</li>
              <li>Appearance fees, win purses and knockout bonuses pay the bills. Every hit you take comes back as a repair bill.</li>
              <li>Sponsors sign on as you win. Fight each bout yourself in the arena, or let your AI driver take it.</li>
            </ul>
            <label class="cn-field">Team name <input id="team" maxlength="28" value="Your Team"></label>
            <div class="cn-label">Starting money</div>
            <div class="cn-choices" id="cn-cash">${cashOpts.map(([id, amt, label]) => `<button class="cn-choice${id === "standard" ? " on" : ""}" data-cash="${amt}"><b>$${amt.toLocaleString()}</b>${esc(label)}</button>`).join("")}
              <label class="cn-choice cn-custom">Custom $<input id="cn-cash-custom" type="number" min="${cashCfg.customMin}" max="${cashCfg.customMax}" step="1000" placeholder="amount"></label></div>
            <div class="cn-label">Difficulty <span class="muted small">(change it any time in Settings)</span></div>
            <div class="cn-choices" id="cn-diff">${["easy", "medium", "hard", "ultimate"].map((d) => `<button class="cn-choice${loadSettings().difficulty === d ? " on" : ""}" data-diff="${d}"><b>${esc(difficultyOf(reg, d).label || d)}</b>${esc(DIFF_BLURB[d])}</button>`).join("")}</div>
            <button class="fight" id="start">Start career</button>
            <button class="ghost" id="import-save">Import a save file…</button>
            <div class="small neg" id="import-msg"></div>
            <p class="muted small">You start with ${esc(me.name)}. Rebuild it in the workshop between fights - buy parts, change the weapon, paint it, and ask the build advisor if you want a second opinion.</p>
          </div>
          <div class="cn-right"><canvas class="stage" id="cn-stage"></canvas><div class="feat-caption"><div class="feat-name">${esc(me.name)}</div><div class="feat-meta">Rookie league · $${reg.economy.startingCash.toLocaleString()} in the bank</div></div></div>
        </div>
      </div>`;
    wireBar();
    showBot("cn-stage", reg.playerId);
    let cash = reg.economy.startingCash;
    const pickOne = (sel, b) => { document.querySelectorAll(sel).forEach((x) => x.classList.toggle("on", x === b)); };
    document.querySelectorAll("[data-cash]").forEach((b) => b.addEventListener("click", () => { cash = Number(b.dataset.cash); pickOne("[data-cash]", b); document.getElementById("cn-cash-custom").value = ""; }));
    document.getElementById("cn-cash-custom")?.addEventListener("input", (e) => {
      const v = Number(e.target.value);
      if (v) { cash = Math.max(cashCfg.customMin, Math.min(cashCfg.customMax, v)); pickOne("[data-cash]", null); }
    });
    document.querySelectorAll("[data-diff]").forEach((b) => b.addEventListener("click", () => { saveSettings({ ...loadSettings(), difficulty: b.dataset.diff }); pickOne("[data-diff]", b); }));
    document.getElementById("start").addEventListener("click", () => actions.start(document.getElementById("team").value, undefined, { startingCash: cash }));
    document.getElementById("import-save")?.addEventListener("click", async () => {
      const text = await pickFile();
      if (text == null) return;
      const r = actions.importSave(text);
      if (!r.ok && r.reason !== "Cancelled.") document.getElementById("import-msg").textContent = r.reason;
    });
  }

  // Everything a button does, in one place - the headless menu check drives these.
  const actions = {
    start(team, seed = (Date.now() & 0x7fffffff) || 1, { startingCash = null, difficulty = null } = {}) {
      if (difficulty) saveSettings({ ...loadSettings(), difficulty });
      career = newCareer(reg, { seed, team: String(team || "").trim() || "Your Team", startingCash, difficulty: loadSettings().difficulty });
      summary = null;
      advanceCareer(reg, career);
      save();
      hub();
    },
    simulate() { summary = simulatePlayerFight(reg, career); save(); show(); },
    // After a fight's result: to the pit, if there is anything to fix.
    cont() { summary = null; if (career.pit) go("career/pit"); else show(); },
    pit() { go("career/pit"); },
    /** Retire the robot (it goes to the museum) and start a new one from its parts. */
    retireRobot(newName) { const r = retireRobot(reg, career, newName); save(); hub(); return r; },
    /** Retire from the career: into the Hall of Fame, and the save is cleared. */
    retireCareer() {
      let hall;
      try { hall = loadHall(localStorage.getItem(HALL_KEY)); } catch { hall = loadHall(null); }
      hall = induct(reg, hall, career);
      try { localStorage.setItem(HALL_KEY, JSON.stringify(hall)); } catch (e) { console.error("[hall] save failed", e); }
      localStorage.removeItem(CAREER_KEY);
      career = null; summary = null; view = "hub";
      go("halloffame");
      return hall;
    },
    nextSeason() { startNextSeason(reg, career); summary = null; advanceCareer(reg, career); save(); hub(); },
    fight() { const nf = nextFight(reg, career); if (nf) arenaFight(nf); },
    /** Watch the opponent's last fight in the arena (a re-run: the robots as they are now). */
    watchTape() { const nf = nextFight(reg, career); if (nf) watchTape(nf); },
    tab(id) { tab = id; hub(); },
    /** Demand a rematch with the robot you just fought (they may say no). */
    rematch() {
      const lf = career.lastFight;
      const r = askRematch(reg, career, { nameOf: rname, personality: lf ? fieldedDef(reg, career, lf.oppId).personality : "" });
      save(); hub(); return r;
    },
    /** Answer a rival's call-out. */
    answer(accept) { const r = answerChallenge(reg, career, !!accept, rname); save(); hub(); return r; },
    /** Call off a booked grudge match. */
    cancelGrudge() { const r = cancelGrudge(reg, career, rname); career.prep = null; save(); hub(); return r; },
    // ---- the Market tab (market.js): loans, the paddock, selling the robot
    borrow(lenderId, amount) { return marketDone(borrow(reg, career, lenderId, amount), (r) => `Borrowed ${money(amount)}.`); },
    repay(lenderId, amount = Infinity) {
      const owed = (career.loans || []).find((l) => l.lender === lenderId)?.owed ?? 0;
      const amt = Number.isFinite(amount) && amount > 0 ? amount : Math.min(owed, Math.max(0, Math.floor(career.cash)));
      return marketDone(repay(reg, career, lenderId, amt), (r) => `Paid off ${money(r.paid)}${debt(career) ? `; ${money(debt(career))} still owed` : " - debt free"}.`);
    },
    buyListing(id) { return marketDone(buyListing(reg, career, id), (r) => `Bought: ${reg.part(r.listing.partId).name}, for ${money(r.listing.price)}. It is in your spares - fit it in the workshop.`); },
    sellToTeam(partId) { return marketDone(sellToTeam(reg, career, partId), (r) => `Sold to ${r.team} for ${money(r.price)}.`); },
    sellToShop(partId) { const r = sellPart(reg, career, partId); return marketDone({ ...r, reason: r.ok ? "" : "That part is not a spare." }, (x) => `Sold to the shop for ${money(x.refund)}.`); },
    sellRobot(newName) { return marketDone(sellRobot(reg, career, newName), (r) => `${r.offer.team} bought it for ${money(r.offer.price)}. Meet ${garageOf(reg, career).name}, on a stock kit - the workshop is open.`); },
    /** Load a save file's text (savefile.js) and carry on from it. */
    importSave(text, ask = true) {
      const r = importText(text, { ask });
      if (r.ok) { reload(); show(); }
      return r;
    },
    /** Open the workshop; `ask` opens it on the advisor with that question asked. */
    workshop(ask = null) {
      go("career/workshop");
      if (ask) workshop.actions.ask(ask);
    },
  };

  /** After a Market action: save, say what happened, show the tab again. */
  function marketDone(r, say) {
    marketMsg = { ok: !!r.ok, text: r.ok ? say(r) : r.reason || "That did not work." };
    if (r.ok) save();
    tab = "market";
    hub();
    return r;
  }

  function hub() {
    const s = career.season;
    const nf = career.seasonOver ? null : nextFight(reg, career);
    const lg = playerLeague(career);
    const where = s.kind === "giantNut" ? "Giant Nut" : `${LEAGUE_TITLES[lg]} league`;
    const roundLabel = s.done ? "season over" : s.round < s.groupRounds ? `group round ${s.round + 1} of ${s.groupRounds}` : "finals";
    app.innerHTML = `
      <div class="screen career">
        ${bar(`Career · Season ${s.index} · ${where}`, `${roundLabel} &nbsp;·&nbsp; <b class="${career.cash < 0 ? "neg" : ""}">${money(career.cash)}</b>`)}
        ${noticesHtml()}
        <div class="cr-main">
          <section class="cr-left">${summary ? resultHtml(summary) : career.seasonOver ? seasonOverHtml() : nf ? nextHtml(nf) : `<div class="panel">Waiting on the other fights...</div>`}</section>
          <section class="cr-right">
            <div class="tabs">${TABS.map(([id, label]) => `<button class="tab${tab === id ? " on" : ""}" data-tab="${id}">${label}</button>`).join("")}</div>
            <div class="tab-body" id="tab-body">${tabHtml()}</div>
          </section>
        </div>
      </div>`;
    wireBar();
    app.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => actions.tab(b.dataset.tab)));
    app.querySelector("[data-dismiss]")?.addEventListener("click", () => { career.notices = []; save(); hub(); });
    const on = (id, fn) => document.getElementById(id)?.addEventListener("click", fn);
    on("fight", () => actions.fight());
    on("simulate", () => actions.simulate());
    on("workshop", () => actions.workshop());
    on("workshop2", () => actions.workshop());
    on("plan", () => actions.workshop("fight"));
    on("to-pit", () => actions.pit());
    on("retire-robot", () => {
      const name = prompt("Retire this robot to the museum and build a new one. Name the new robot:", "");
      if (name !== null) actions.retireRobot(name);
    });
    on("retire-career", () => {
      if (!confirm("Retire from the career? Your team goes into the Hall of Fame and this career ends.")) return;
      actions.retireCareer();
    });
    on("continue", () => actions.cont());
    on("watch-tape", () => actions.watchTape());
    on("rematch", () => actions.rematch());
    on("accept-callout", () => actions.answer(true));
    on("decline-callout", () => actions.answer(false));
    on("cancel-grudge", () => { if (confirm("Call off the grudge match? Their fans will say you ducked it.")) actions.cancelGrudge(); });
    on("next-season", () => {
      // The off-season takes a second or two (every team tests its upgrades):
      // say so first, then do it.
      const btn = document.getElementById("next-season");
      if (btn) { btn.disabled = true; btn.textContent = "The teams are rebuilding their robots..."; }
      setTimeout(() => actions.nextSeason(), 30);
    });
    on("retire", () => {
      if (!confirm("Delete this career? This cannot be undone.")) return;
      localStorage.removeItem(CAREER_KEY);
      career = null; summary = null;
      newView();
    });
    if (tab === "market") wireMarket(document.getElementById("tab-body"), actions);
    if (nf && !summary) showDef("opp-stage", nf.opp, undefined, nf.oppCondition);
    const cs = document.getElementById("career-settings");
    if (cs) renderSettings(cs, {
      note: "These are the game's settings - the same as on the main menu. Difficulty applies to your career from the next fight.",
      onChange: (st, id) => { if (id === "difficulty") { syncSettings(); hub(); } },
    });
    const sv = document.getElementById("career-saves");
    if (sv) { save(); renderSaves(sv, { title: "Back up this career", only: ["career"], onImported: () => { reload(); show(); } }); }
  }

  function arenaFight(nf) {
    save();
    const o = nf.opp;
    localStorage.setItem(FIGHT_KEY, JSON.stringify({
      fixtureId: nf.fixture.id, oppId: nf.oppId, at: Date.now(),
      // The opponent as it is now: its latest build and driver.
      // As it has set itself up for you: build, body, tactics and the difficulty's edge.
      oppDef: { build: o.build, body: o.body, rating: o.rating, league: o.league, archetype: o.archetype, version: o.version,
        personality: o.personality, tactics: o.tactics || null, skillBonus: o.skillBonus ?? 0, learnRate: o.learnRate ?? 0.7 },
      // And you, as built in the workshop.
      meId: career.playerId,
      // The damage both robots carry in (Stage 7: the pits did not fix everything).
      meCondition: nf.myCondition || {},
      oppCondition: nf.oppCondition || null,
      meDef: (({ name, body, build, livery, personality, archetype, league, partner }) => ({ name, body, build, livery, personality, archetype, league, partner }))(fieldedDef(reg, career, career.playerId)),
      mePartnerCondition: nf.myPartnerCondition || null,
      // Where it is: venue and hazard layout.
      arena: nf.arena || null,
      // The story so far, for the commentary and the intro (rivalry.js).
      story: storyOf(nf),
    }));
    localStorage.removeItem(RESULT_KEY);
    const q = new URLSearchParams({
      red: career.playerId, blue: nf.oppId, driver: "you", seed: String(nf.seed & 0xffff),
      league: nf.opp.league, career: "1",
    });
    location.href = `fight.html?${q}`;
  }

  /** The opponent's last fight, re-run in the arena with the robots as they are now. */
  function watchTape(nf) {
    const tape = scoutReport(reg, career, nf.oppId).tape;
    if (!tape) return;
    save();
    const other = tape.a === nf.oppId ? tape.b : tape.a;
    const defOf = (id) => {
      const d = id === nf.oppId ? nf.opp : fieldedDef(reg, career, id);
      return (({ name, body, build, livery, personality, archetype, league, partner, rating, tactics }) => ({ name, body, build, livery, personality, archetype, league, partner, rating, tactics }))(d);
    };
    localStorage.setItem(SCOUT_KEY, JSON.stringify({
      red: { id: nf.oppId, def: defOf(nf.oppId) }, blue: { id: other, def: defOf(other) },
      label: `SCOUTING TAPE · ${rname(nf.oppId)} v ${rname(other)} · ${tape.label || `season ${tape.season}`}`,
      real: tapeLineFor(tape, nf.oppId),
    }));
    const q = new URLSearchParams({
      red: nf.oppId, blue: other, driver: "ai", scout: "1", seed: String(hashOf(tape.id) & 0xffff),
      venue: tape.arena?.venue || "rookie", layout: tape.arena?.layout || "random",
    });
    location.href = `fight.html?${q}`;
  }
  const tapeLineFor = (tape, id) => scoutReport(reg, career, id, { nameOf: rname }).tapeText;
  const hashOf = (str) => { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

  /** The scouts' notes: its form this season, how it wins and loses, and the tape. */
  function formHtml(nf) {
    const myCls = playerDef(reg, career).build.weapon ? reg.part(playerDef(reg, career).build.weapon).spec.class : "none";
    const rep = scoutReport(reg, career, nf.oppId, { nameOf: rname, myClass: myCls });
    const chips = rep.form.map((x) => `<span class="form-chip ${x.won ? "w" : "l"}" title="${x.won ? "beat" : "lost to"} ${esc(rname(x.oppId))} (${esc(METHOD[x.method] || x.method)})">${x.won ? "W" : "L"}${x.method === "ko" || x.method === "tapout" ? "<i>KO</i>" : ""}</span>`).join("");
    const vs = rep.vs.length ? `<div class="card-meta">Its record against ${rep.vs.map((v) => `${esc(v.name)} ${v.w}-${v.l}`).join(", ")}.</div>` : "";
    return `<div class="scout-sub">Form${rep.form.length ? ` <span class="form-chips">${chips}</span>` : ""}</div>
      ${rep.lines.length ? `<ul class="scout-list">${rep.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : `<p class="muted small">No fights yet this season.</p>`}
      ${vs}
      ${rep.tape ? `<div class="scout-tape"><span class="small">${esc(rep.tapeText)}</span>
        <button class="ghost tiny" id="watch-tape">Watch the tape</button>
        <div class="muted small">A re-run in the arena with both robots as they are now - it may not end the same way.</div></div>` : ""}`;
  }

  // ---------------------------------------------------------------- left column

  /** What the fight screen needs to know about the rivalry. */
  function storyOf(nf) {
    const e = rivalOf(career, nf.oppId);
    const lv = levelOf(reg, e);
    return {
      grudge: !!nf.grudge, asked: nf.grudge ? career.grudge?.asked ?? null : null,
      level: lv.level, name: lv.name, series: e ? { w: e.w, l: e.l, fights: e.fights, koFor: e.koFor, koAgainst: e.koAgainst } : null,
      last: e?.last ? { won: e.last.won, method: e.last.method, season: e.last.season, stageName: e.last.stageName } : null,
      lines: storyline(reg, career, nf.oppId, { names: { them: rname(nf.oppId), me: rname(career.playerId) }, driver: career.drivers?.[nf.oppId]?.name, grudge: nf.grudge ? career.grudge : null }),
      stage: stageLabel(nf.fixture),
    };
  }

  function stageLabel(f) {
    const s = career.season;
    if (f.stage === "grudge") return "Outside the standings";
    if (f.stage === "group") return `${f.league === "giantNut" ? "Giant Nut " : ""}Group ${f.group} · round ${f.round + 1}`;
    const b = f.league === "giantNut" ? s.giantNut.bracket : s.leagues[f.league].finals;
    return `${f.league === "giantNut" ? "Giant Nut " : `${LEAGUE_TITLES[f.league]} `}${roundName(b, f.bracketRound)}`;
  }

  function nextHtml(nf) {
    const sc = scouting(reg, nf.opp);
    const stats = [
      ["Weapon", sc.weaponClass], ["Weight", `${sc.weightLb} lb`], ["Top speed", `${sc.topSpeedMph} mph`],
      ["Armour", `${sc.armourHp} hp`], ["Push", `${sc.pushRatio}×`], ...(sc.weaponEnergyKJ ? [["Energy", `${sc.weaponEnergyKJ} kJ`]] : []),
    ];
    const rec = recordOf(career.season, nf.oppId);
    const ver = versionOf(career, nf.oppId);
    const evo = career.evolution?.[nf.oppId];
    const changes = (evo?.log || []).slice(-2).reverse();
    return `
      ${challengeHtml()}
      <div class="panel next${nf.grudge ? " grudge" : ""}">
        ${nf.grudge ? `<div class="grudge-head">GRUDGE MATCH${career.grudge?.asked === "them" ? " · they called you out" : " · you asked for it"}</div>` : ""}
        <div class="next-stage">${esc(stageLabel(nf.fixture))}${nf.arena ? ` <span class="next-where">· ${esc(venueOf(reg, nf.arena.venue)?.name ?? "")} · ${esc(layoutOf(reg, nf.arena.layout)?.name ?? "")}</span>` : ""}</div>
        <div class="next-vs"><span class="me">${esc(rname(career.playerId))}</span> <span class="vs-small">vs</span> <span class="them">${esc(sc.name)}</span>${ver !== "1.0" ? ` <span class="ver">v${ver}</span>` : ""}</div>
        <div class="next-show">
          <canvas class="stage" id="opp-stage"></canvas>
          <div class="scout">
            <div class="scout-head">Scouting report</div>
            <div class="card-meta">${esc(sc.team)} · ${esc(LEAGUE_TITLES[nf.opp.league])} · ${esc(sc.driver.personality)} driver, rated ${sc.driver.rating}${rec.wins + rec.losses ? ` · ${rec.wins}-${rec.losses} this season` : ""}</div>
            ${driverLine(nf.oppId)}
            <div class="card-weapon">${esc(sc.weapon)}${sc.partner ? ` + ${esc(sc.partner.name)} (${esc(sc.partner.weapon)})` : ""}</div>
            <div class="card-stats">${stats.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
            ${sc.notes.length ? `<div class="scout-sub">Watch for</div><ul class="scout-list">${sc.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
            ${sc.weak.length ? `<div class="scout-sub weak">Weak points</div><ul class="scout-list">${sc.weak.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
            ${nf.oppChanges?.length ? `<div class="scout-sub">Set up for you</div><ul class="scout-list">${nf.oppChanges.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
            ${memoryLine(nf.oppId)}
            ${formHtml(nf)}
            ${historyHtml(nf)}
            ${nf.arena ? `<div class="scout-sub">The arena</div><div class="scout-arena">${esc(layoutOf(reg, nf.arena.layout)?.blurb ?? "")}</div>` : ""}
            ${changes.length ? `<div class="scout-sub">Off-season work</div><ul class="scout-list">${changes.map((c) => c.notes.map((n) => `<li><span class="muted">S${c.season}:</span> ${esc(n)}</li>`).join("")).join("")}</ul>` : ""}
            ${sc.inspiredBy ? `<div class="card-nod">a nod to ${esc(sc.inspiredBy)}</div>` : ""}
          </div>
        </div>
        ${conditionLine(nf)}
        ${career.pit ? `
        <div class="next-actions">
          <button class="fight" id="to-pit">To the pit</button>
        </div>
        <p class="muted small">Your robot is still in the pit from the last fight. Fix what you can, then send it out.</p>` : `
        <div class="next-actions">
          <button class="fight" id="fight">FIGHT!</button>
          <button class="ghost" id="simulate">Let your AI driver fight it</button>
          ${nf.grudge ? `<button class="ghost tiny" id="cancel-grudge">Call it off</button>` : ""}
        </div>`}
        ${nf.grudge ? `<p class="muted small">${grudgeTerms(nf)}</p>` : ""}
        <div class="next-actions ws-links">
          <button class="ghost" id="workshop">Workshop</button>
          ${loadSettings().advisor ? `<button class="ghost" id="plan">Ask the advisor for a game plan</button>` : ""}
          <span class="muted small">${esc(rname(career.playerId))} v${esc(garageOf(reg, career).version)} · ${esc(garageOf(reg, career).personality)} driver</span>
        </div>
        <p class="muted small">Damage stays on your robot until you fix it in the pit${partsDiscount(reg, career) ? ` (${Math.round(partsDiscount(reg, career) * 100)}% parts discount)` : ""}; everyone else's does too.</p>
      </div>`;
  }

  function resultHtml(sum) {
    const r = sum.result;
    const opp = rname(sum.oppId);
    const how = r.method === "decision" ? `${r.decision === "unanimous" ? "unanimous" : "split"} decision` : `${METHOD[r.method]}${r.method === "ko" && r.cause ? ` (${esc(r.cause)})` : ""} at ${fmt(r.elapsedS)}`;
    const lines = sum.lines || [];
    return `
      <div class="panel result ${sum.won ? "won" : "lost"}">
        <div class="res-big">${sum.won ? "WIN" : "LOSS"}</div>
        <div class="res-line">vs ${esc(opp)} · ${how}${r.by === "sim" ? " · fought by your AI driver" : ""}</div>
        ${sum.repair.lines.length ? `<div class="scout-sub">Damage</div><table class="ledger">${sum.repair.lines.map((l) =>
          `<tr><td>${esc(l.name)}</td><td class="muted">${Math.round(l.condition * 100)}%</td><td class="muted">${money(l.cost)}</td></tr>`).join("")}
          <tr class="total"><td>To put it all right</td><td></td><td>${money(sum.repair.total)}</td></tr></table>
          <p class="muted small">Nothing is paid yet: the pit is next, and you choose what gets fixed.</p>` : `<p class="muted">Not a scratch on it.</p>`}
        <div class="scout-sub">Money</div>
        <table class="ledger">${lines.map((l) => `<tr><td>${esc(l.label)}</td><td></td><td class="${l.amount < 0 ? "neg" : "pos"}">${money(l.amount)}</td></tr>`).join("")}
          <tr class="total"><td>This fight</td><td></td><td class="${sum.net < 0 ? "neg" : "pos"}">${money(sum.net)}</td></tr></table>
        ${rivalryResultHtml(sum)}
        <button class="fight small" id="continue">${sum.repair.lines.length ? "To the pit" : "Continue"}</button>
      </div>`;
  }

  /** After the fight: the rivalry, a rematch to ask for, a call-out to answer. */
  function rivalryResultHtml(sum) {
    const e = rivalOf(career, sum.oppId);
    if (!e) return "";
    const lv = levelOf(reg, e);
    const can = canAskRematch(reg, career);
    const rm = sum.rematch;
    const lines = [];
    lines.push(`Head to head: ${e.w}-${e.l}${e.fights > 1 ? ` in ${e.fights} meetings` : ""}${lv.level ? ` · <b class="rival-tag l${lv.level}">${esc(lv.name)}</b>` : ""}${sum.rivalry?.levelUp ? " - new!" : ""}`);
    return `<div class="scout-sub">Rivalry</div>
      <p class="small">${lines.join("<br>")}</p>
      ${career.challenge?.fixtureId === sum.fixtureId ? callOutButtons() : ""}
      ${rm ? `<p class="small ${rm.accepted ? "pos" : "muted"}">${rm.accepted ? "Rematch accepted: the grudge match is before your next fight." : "They turned your rematch down."}</p>`
        : can.ok ? `<button class="ghost" id="rematch">Demand a rematch</button> <span class="muted small">a grudge match before your next fight, outside the standings - they may say no</span>`
          : can.reason ? `<p class="muted small">${esc(can.reason)}</p>` : ""}`;
  }

  function callOutButtons() {
    const c = career.challenge;
    return `<div class="callout"><div class="callout-text">${esc(c.text)}</div>
      <button class="fight small" id="accept-callout">Accept the grudge match</button>
      <button class="ghost" id="decline-callout">Turn them down</button></div>`;
  }

  /** A call-out still waiting for an answer, on the hub. */
  function challengeHtml() {
    if (!career.challenge || summary) return "";
    return `<div class="panel">${callOutButtons()}<p class="muted small">Unanswered, it lapses when you fight your next fight.</p></div>`;
  }

  /** The purse and the rules for a grudge match. */
  function grudgeTerms(nf) {
    const order = reg.league.leagues;
    const lg = order[Math.max(order.indexOf(playerLeague(career)), order.indexOf(nf.opp.league))];
    const scale = difficultyOf(reg, career.difficulty || "medium").purse ?? 1;
    const p = grudgePurse(reg, career, nf.oppId, reg.economy.league[lg]);
    return `Not in the standings. ${money(p.appearance * scale)} to turn up, ${money(p.win * scale)} to win${p.koBonus ? `, ${money(p.koBonus * scale)} more for a KO` : ""}. The damage is real: the pit is after it, as usual.`;
  }

  /** The story so far, on the scouting card. */
  function historyHtml(nf) {
    const lines = storyline(reg, career, nf.oppId, { names: { them: rname(nf.oppId) }, driver: career.drivers?.[nf.oppId]?.name, grudge: nf.grudge ? career.grudge : null });
    if (!lines.length) return "";
    const lv = levelOf(reg, rivalOf(career, nf.oppId));
    return `<div class="scout-sub">History${lv.level ? ` <span class="rival-tag l${lv.level}">${esc(lv.name)}</span>` : ""}</div>
      <ul class="scout-list">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
      ${lv.level && !nf.grudge ? `<div class="card-meta">A rival studies you harder and drives fired up; the promoters pay a gate bonus.</div>` : ""}`;
  }

  function seasonOverHtml() {
    const h = career.history[career.history.length - 1];
    const nextIdx = career.seasonIndex + 1;
    const nextKind = reg.league.cycle[(nextIdx - 1) % reg.league.cycle.length];
    let body;
    if (h.kind === "league") {
      const fin = h.finish.stage === "final" ? finishName(h.finish, 16) : "did not make the finals";
      body = `
        <div class="res-big">${h.promoted ? "PROMOTED" : h.relegated ? "RELEGATED" : `#${h.position}`}</div>
        <div class="res-line">${LEAGUE_TITLES[h.league]} league · ${h.record.wins}-${h.record.losses}${h.record.kos ? `, ${h.record.kos} KO` : ""} · ${fin} · finished ${ordinal(h.position)} of 30</div>
        <div class="scout-sub">Champions</div>
        <table class="ledger">${reg.league.leagues.slice().reverse().map((lg) => `<tr><td>${LEAGUE_TITLES[lg]}</td><td colspan="2" class="${isMe(h.champions[lg]) ? "pos" : ""}">${esc(nameOf(h.champions[lg]))}</td></tr>`).join("")}</table>
        <p>Next season you ${h.promoted || h.relegated ? "fight in" : "stay in"} the <b>${LEAGUE_TITLES[h.nextLeague]}</b> league.</p>`;
    } else {
      const fin = h.finish.stage === "final" ? finishName(h.finish, 64) : "out in the group stage";
      body = `
        <div class="res-big">${isMe(h.champion) ? "GIANT NUT CHAMPION" : "GIANT NUT"}</div>
        <div class="res-line">${h.record.wins}-${h.record.losses}${h.record.kos ? `, ${h.record.kos} KO` : ""} · ${fin}</div>
        <div class="scout-sub">The Giant Nut goes to</div><p class="big-name">${esc(nameOf(h.champion))}</p>
        <p>Everyone goes back to their league. You are back in the <b>${LEAGUE_TITLES[playerLeague(career)]}</b> league.</p>`;
    }
    return `
      <div class="panel result season-end">
        <div class="next-stage">Season ${h.season} is over</div>
        ${body}
        ${career.grudge ? `<p>Grudge match booked: you against <b>${esc(rname(career.grudge.oppId))}</b>, before your first fight of season ${nextIdx}.</p>` : ""}
        <button class="fight small" id="next-season">Start season ${nextIdx}${nextKind === "giantNut" ? ": THE GIANT NUT" : ""}</button>
        <button class="ghost" id="workshop2">Workshop</button>
      </div>`;
  }

  function noticesHtml() {
    if (!career.notices.length) return "";
    return `<div class="notices">${career.notices.slice(-4).map((n) => `<div class="notice ${n.kind}">${esc(n.text)}</div>`).join("")}<button class="ghost tiny" data-dismiss>Dismiss</button></div>`;
  }

  // ---------------------------------------------------------------- tabs

  function tabHtml() {
    if (tab === "standings") return standingsHtml();
    if (tab === "bracket") return bracketHtml();
    if (tab === "results") return resultsHtml();
    if (tab === "money") return moneyHtml();
    if (tab === "rivals") return rivalsHtml();
    if (tab === "market") { const msg = marketMsg; marketMsg = null; return marketHtml({ reg, career, esc, rname, message: msg }); }
    if (tab === "settings") return `<div id="career-saves"></div><div id="career-settings"></div>`;
    return trophiesHtml();
  }

  function standingsHtml() {
    const s = career.season;
    const comp = s.kind === "league" ? playerLeague(career) : "giantNut";
    const tables = groupTables(s)[comp];
    const mine = playerGroup(career)?.name;
    const names = Object.keys(tables).sort((x, y) => (x === mine ? -1 : y === mine ? 1 : x < y ? -1 : 1));
    const cut = s.kind === "league" ? reg.league.league.finals.perGroup : reg.league.giantNut.advance;
    const wild = s.kind === "league" ? new Set(s.leagues[comp].wildCards || []) : new Set();
    return `<p class="muted small">${s.kind === "league" ? `Top ${cut} of each group and the 4 best of the rest go to the finals.` : `Top ${cut} of each group go to the 64-robot bracket.`} Ranked by wins, then knockouts, then damage.</p>
      <div class="groups">${names.map((g) => `
        <table class="table${g === mine ? " mine" : ""}">
          <tr><th colspan="2">Group ${g}</th><th>W</th><th>L</th><th>KO</th><th>Dmg</th></tr>
          ${tables[g].map((r, i) => `<tr class="${isMe(r.id) ? "me" : ""}${i < cut ? " q" : wild.has(r.id) ? " wc" : ""}"><td>${i + 1}</td><td>${esc(rname(r.id))}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.kos}</td><td>${Math.round(r.damage)}</td></tr>`).join("")}
        </table>`).join("")}</div>`;
  }

  function bracketHtml() {
    const s = career.season;
    const comp = s.kind === "league" ? playerLeague(career) : "giantNut";
    const b = s.kind === "league" ? s.leagues[comp].finals : s.giantNut.bracket;
    if (!b) return `<p class="muted">The ${s.kind === "league" ? "16-robot finals are" : "64-robot bracket is"} drawn when the group stage ends.</p>`;
    const nm = (id) => (id ? esc(rname(id)) : `<span class="muted">${"—"}</span>`);
    return `<div class="bracket">${b.rounds.map((ms, r) => `
      <div class="b-round"><div class="b-title">${roundName(b, r)}</div>
        ${ms.map((m) => `<div class="b-match${m.a && isMe(m.a) || m.b && isMe(m.b) ? " me" : ""}">
          <div class="${m.winner && m.winner === m.a ? "w" : ""}${isMe(m.a) ? " you" : ""}">${m.bye && !m.a ? "<span class=muted>bye</span>" : nm(m.a)}</div>
          <div class="${m.winner && m.winner === m.b ? "w" : ""}${isMe(m.b) ? " you" : ""}">${m.bye && !m.b ? "<span class=muted>bye</span>" : nm(m.b)}</div>
          ${m.result ? `<div class="b-how">${METHOD[m.result.method]}${m.result.method === "decision" ? "" : ` ${fmt(m.result.elapsedS)}`}</div>` : ""}
        </div>`).join("")}
      </div>`).join("")}</div>`;
  }

  function resultsHtml() {
    const s = career.season;
    const me = career.playerId;
    const comp = s.kind === "league" ? playerLeague(career) : "giantNut";
    const all = [...s.fixtures, ...(s.finalsLog || [])].filter((f) => f.result && f.league === comp);
    const mine = all.filter((f) => f.a === me || f.b === me);
    const rest = all.filter((f) => f.a !== me && f.b !== me).slice(-24).reverse();
    const row = (f) => {
      const r = f.result;
      return `<tr class="${f.a === me || f.b === me ? (r.winnerId === me ? "won" : "lost") : ""}"><td class="${r.winnerId === f.a ? "w" : ""}">${esc(rname(f.a))}</td><td class="${r.winnerId === f.b ? "w" : ""}">${esc(rname(f.b))}</td><td class="muted">${METHOD[r.method]}${r.method !== "decision" ? ` ${fmt(r.elapsedS)}` : ""}</td><td class="muted">${f.stage === "group" ? `Grp ${f.group}` : "Finals"}</td></tr>`;
    };
    const off = career.offseason;
    const fr = off?.field;
    const fieldHtml = fr ? `<div class="scout-sub">The field moves on (before season ${off.season + 1})</div>
      <table class="table wide">
        ${fr.retiredDrivers.map((d) => `<tr><td>${esc(d.name)}</td><td class="muted">retired after ${d.years} seasons driving ${esc(d.robot)}</td></tr>`).join("")}
        ${fr.newDrivers.map((d) => `<tr><td>${esc(d.name)}</td><td class="muted">takes over ${esc(d.robot)} from ${esc(d.follows)}</td></tr>`).join("")}
        ${fr.retiredRobots.map((r) => `<tr><td>${esc(r.name)}</td><td class="muted">retired: ${esc(r.why)}</td></tr>`).join("")}
        ${fr.newRobots.map((r) => `<tr><td>${esc(r.name)}</td><td class="muted">${r.newTeam ? `new team ${esc(r.team)} joins Rookie` : `${esc(r.team)}'s new robot (replaces ${esc(r.replaces)})`}</td></tr>`).join("")}
        ${fr.promoted.map((p) => `<tr><td>${esc(p.name)}</td><td class="muted">moves up to ${esc(LEAGUE_TITLES[p.to])} to fill a place</td></tr>`).join("")}
      </table>` : "";
    const offHtml = off && off.moves.length ? `<div class="scout-sub">Off-season before season ${off.season + 1}</div>
      <table class="table wide">${off.moves.filter((m) => m.notes.some((n) => !n.startsWith("driver"))).slice(0, 40).map((m) =>
        `<tr><td>${esc(rname(m.id))} <span class="muted">v${m.version}</span></td><td class="muted">${m.notes.map(esc).join("; ")}</td></tr>`).join("")}</table>` : "";
    return `<div class="scout-sub">Your fights</div>
      ${mine.length ? `<table class="table wide">${mine.map(row).join("")}</table>` : `<p class="muted">No fights yet this season.</p>`}
      <div class="scout-sub">Around the ${comp === "giantNut" ? "Giant Nut" : "league"}</div>
      ${rest.length ? `<table class="table wide">${rest.map(row).join("")}</table>` : `<p class="muted">Nothing yet.</p>`}
      ${fieldHtml}
      ${offHtml}`;
  }

  function rivalsHtml() {
    const list = rivalsList(reg, career);
    const gone = rivalsList(reg, career, { active: false }).filter((r) => r.retired || !(r.id in career.membership)).slice(0, 8);
    const grudges = (career.grudgeLog || []).slice(-8).reverse();
    const row = (r) => `<tr><td><b>${esc(rname(r.id))}</b>${r.level ? ` <span class="rival-tag l${r.level}">${esc(r.name)}</span>` : ""}<div class="muted small">${esc(r.moments.slice(-1)[0]?.text || (r.last ? `Last met in season ${r.last.season}.` : ""))}</div></td>
      <td>${r.w}-${r.l}</td><td class="muted">${r.koFor || r.koAgainst ? `KO ${r.koFor}-${r.koAgainst}` : ""}</td><td class="muted">${esc(LEAGUE_TITLES[career.membership[r.id]] || "")}</td></tr>`;
    return `<p class="muted small">Every robot you have fought keeps a record against you. Knockouts, playoff fights, split decisions, revenge and upsets heat a rivalry up; it cools between seasons. A rival studies you harder, drives fired up and draws a gate bonus. After any fight you can demand a rematch - a grudge match, outside the standings - and a rival you beat may call you out.</p>
      ${career.grudge ? `<div class="callout"><div class="callout-text">Booked: a grudge match against ${esc(rname(career.grudge.oppId))}, before your next fight.</div></div>` : ""}
      ${list.length ? `<table class="table wide"><tr><th>Robot</th><th>W-L</th><th></th><th></th></tr>${list.map(row).join("")}</table>` : `<p class="muted">No history yet: fight someone.</p>`}
      ${grudges.length ? `<div class="scout-sub">Grudge matches</div><table class="table wide">${grudges.map((g) => `<tr class="${g.won ? "won" : "lost"}"><td>${esc(rname(g.oppId))}</td><td>${g.won ? "won" : "lost"}</td><td class="muted">${METHOD[g.method] || g.method}</td><td class="muted">S${g.season}${g.asked === "them" ? " · they called you out" : " · you asked"}</td></tr>`).join("")}</table>` : ""}
      ${gone.length ? `<div class="scout-sub">Retired rivals</div><table class="table wide">${gone.map((r) => `<tr><td>${esc(rname(r.id))}</td><td>${r.w}-${r.l}</td><td class="muted">${r.retired ? `retired S${r.retired}` : ""}</td></tr>`).join("")}</table>` : ""}`;
  }

  function moneyHtml() {
    const disc = partsDiscount(reg, career);
    const signed = career.sponsors.map((id) => reg.economy.sponsors.find((s) => s.id === id)).filter(Boolean);
    const open = reg.economy.sponsors.filter((s) => s.kind === "league" && !career.sponsors.includes(s.id));
    const req = (q) => [q.wins && `${q.wins} wins`, q.kos && `${q.kos} knockouts`, q.league && `reach the ${LEAGUE_TITLES[q.league]} league`].filter(Boolean).join(", ");
    return `
      <div class="cash-big ${career.cash < 0 ? "neg" : ""}">${money(career.cash)}</div>
      ${career.cash < 0 ? `<p class="neg small">You are in debt. Win some purses before the repair bills bury you - or see the bank on the Market tab.</p>` : ""}
      ${debt(career) ? `<p class="small">Loans: <b class="neg">${money(debt(career))}</b> owed (Market tab).</p>` : ""}
      <div class="scout-sub">Sponsors</div>
      ${signed.length ? `<table class="ledger">${signed.map((s) => `<tr><td><b>${esc(s.name)}</b><div class="muted small">${esc(s.blurb)}</div></td><td>${money(s.retainer)}/season</td><td>${s.perWin ? `${money(s.perWin)}/win` : ""}</td></tr>`).join("")}</table>` : `<p class="muted">No sponsors yet.</p>`}
      ${open.length ? `<div class="muted small">Interested if you ${open.map((s) => `${req(s.requires)} (${esc(s.name)})`).join("; ")}.</div>` : ""}
      ${disc ? `<p>Parts discount: <b>${Math.round(disc * 100)}%</b></p>` : ""}
      ${career.unlocks.length ? `<p>Unlocked: ${career.unlocks.map(esc).join(", ")}</p>` : ""}
      <div class="scout-sub">Ledger</div>
      <table class="ledger">${career.ledger.slice(-30).reverse().map((l) => `<tr><td>${esc(l.label)}</td><td class="muted">S${l.season}</td><td class="${l.amount < 0 ? "neg" : "pos"}">${money(l.amount)}</td></tr>`).join("") || `<tr><td class="muted">Nothing yet.</td></tr>`}</table>`;
  }

  function trophiesHtml() {
    const st = career.stats;
    return `
      <div class="scout-sub">Career</div>
      <p>${st.fights} fights · ${st.wins} wins · ${st.losses} losses · ${st.kos} knockouts · ${Math.round(st.damageDealt).toLocaleString()} damage dealt</p>
      <div class="scout-sub">League titles</div>
      ${career.trophies.length ? `<ul class="trophies">${career.trophies.map((t) => `<li>🏆 ${esc(t.title)} <span class="muted">season ${t.season}</span></li>`).join("")}</ul>` : `<p class="muted">None yet.</p>`}
      <div class="scout-sub">Giant Nut</div>
      ${career.giantNutHistory.length ? `<table class="ledger">${career.giantNutHistory.map((g) => `<tr><td>Season ${g.season}</td><td>${isMe(g.champion) ? "🔩 CHAMPION" : g.finish.stage === "final" ? finishName(g.finish, 64) : "group stage"}</td><td class="muted">won by ${esc(nameOf(g.champion))}</td></tr>`).join("")}</table>` : `<p class="muted">The first Giant Nut is season 3.</p>`}
      <div class="scout-sub">Seasons</div>
      ${career.history.length ? `<table class="ledger">${career.history.map((h) => `<tr><td>Season ${h.season}</td><td>${h.kind === "league" ? `${LEAGUE_TITLES[h.league]} · ${ordinal(h.position)}${h.promoted ? " · promoted" : h.relegated ? " · relegated" : ""}` : "Giant Nut"}</td><td class="muted">${h.record.wins}-${h.record.losses}</td></tr>`).join("")}</table>` : `<p class="muted">Your first season is under way.</p>`}
      <div class="scout-sub">Your robots</div>
      ${museumHtml()}
      <div class="retire-row">
        <button class="ghost tiny" id="retire-robot">Retire ${esc(rname(career.playerId))}…</button>
        <button class="ghost tiny" id="retire-career">Retire from the career (Hall of Fame)…</button>
      </div>
      <div class="danger"><button class="ghost tiny" id="retire">Delete career</button></div>`;
  }

  /** Who drives it, and for how long. */
  function driverLine(id) {
    const d = career.drivers?.[id];
    if (!d) return "";
    const nth = d.years + 1;
    const stage = d.years / Math.max(1, d.span);
    return `<div class="card-meta">Driven by ${esc(d.name)}, in their ${ordinal(nth)} season${stage > 0.8 ? " - a veteran near the end" : nth <= 2 ? " - a rookie at the sticks" : ""}${d.gen > 1 ? ` (the robot's ${ordinal(d.gen)} driver)` : ""}.</div>`;
  }
  /** What it has learned about robots like yours (ailearn.js). */
  function memoryLine(id) {
    const myCls = playerDef(reg, career).build.weapon ? reg.part(playerDef(reg, career).build.weapon).spec.class : "none";
    const v = career.ai?.[id]?.vs?.[myCls];
    if (!v || v.f < 2) return "";
    const how = Object.entries(v.lossBy || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    return `<div class="card-meta">Has fought ${v.f} robots with your kind of weapon and won ${v.w}${how ? ` - lost mostly by ${how.replace("ko:", "being ")}` : ""}. It remembers.</div>`;
  }

  /** The player's robots, retired and current, with their records. */
  function museumHtml() {
    const g = garageOf(reg, career);
    const cur = g.record || { fights: 0, wins: 0, kos: 0, titles: 0, since: 1 };
    const rows = [...(g.museum || []).map((m) => ({ ...m, retired: true })), { name: g.name, version: g.version, from: cur.since, to: career.seasonIndex, ...cur, retired: false }];
    return `<table class="ledger">${rows.map((r) => `<tr><td><b>${esc(r.name)}</b> <span class="muted">v${esc(r.version)} · S${r.from}-${r.retired ? r.to : "now"}</span></td>
      <td class="muted">${r.wins}-${r.fights - r.wins}${r.kos ? `, ${r.kos} KO` : ""}${r.titles ? ` · ${r.titles} title${r.titles > 1 ? "s" : ""}` : ""}</td><td>${r.sold ? `sold to ${esc(r.sold.team)}` : r.retired ? "retired" : "racing"}</td></tr>`).join("")}</table>`;
  }

  /** Both robots' damage as they will turn up for the fight. */
  function conditionLine(nf) {
    const mine = assembleRobot(reg, playerDef(reg, career));
    Object.assign(mine.condition, nf.myCondition || {});
    const theirs = assembleRobot(reg, nf.opp);
    Object.assign(theirs.condition, (nf.oppCondition || [])[0] || {});
    const say = (a) => {
      const d = damageSummary(reg, a);
      return d.fresh ? "fresh" : d.worst.map((x) => `${esc(x.name)} ${Math.round(x.c * 100)}%`).join(", ") + (d.count > 3 ? ` +${d.count - 3} more` : "");
    };
    return `<div class="cond-line"><span class="muted">You:</span> ${say(mine)} &nbsp;·&nbsp; <span class="muted">${esc(nf.opp.name)}:</span> ${say(theirs)}</div>`;
  }

  // ---------------------------------------------------------------- bits

  function bar(title, right) {
    return `<header class="bar"><button class="back" data-go="main">Menu</button><div class="bar-title">${title}</div><div class="bar-hint">${right}</div></header>`;
  }
  function wireBar() { app.querySelector("[data-go]")?.addEventListener("click", () => go("main")); }

  return {
    show,
    actions,
    keys(e) {
      if (view !== "hub") return;
      if (e.key === "Enter" && document.getElementById("fight") && career) { e.preventDefault(); document.getElementById("fight").click(); }
    },
    /** Esc: step back out of the workshop or the pit. True if it did. */
    back() {
      if (view !== "workshop" && view !== "pit") return false;
      go("career");
      return true;
    },
    /** The router (menu.js): #career, #career/workshop or #career/pit. */
    open(sub = "") {
      view = career && sub === "workshop" ? "workshop" : career?.pit && sub === "pit" ? "pit" : "hub";
      show();
    },
    workshop,
    pit,
    reload,
    get career() { return career; },
  };
}

function load() {
  try {
    const text = localStorage.getItem(CAREER_KEY);
    return text ? deserialize(text) : null;
  } catch (e) {
    console.error("[career] could not load the save", e);
    return null;
  }
}

function finishName(fin, size) {
  if (fin.finish >= fin.rounds) return "won the title";
  const left = fin.rounds - fin.finish;
  return left === 1 ? "lost in the final" : left === 2 ? "lost in the semifinals" : left === 3 ? "lost in the quarterfinals" : `lost in the round of ${size >> fin.finish}`;
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
