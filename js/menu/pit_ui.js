// pit_ui.js - the Stage 7 pit: between fights, choose what to fix.
//
// After every fight the robot comes back with whatever it took. The crew has
// the pit window (minutes until the next fight) times its size in
// crew-minutes; each damaged part can be left, patched, repaired or replaced,
// each with a price and a time. What is not fixed goes into the next fight -
// the panel on the left shows what the robot will be able to do. The rules
// are js/logic/pit.js and career.js; this only shows them.

import {
  pitState, pitQuote, pitAutoPlan, doPit, skipPit, crewSize, crewConfig, hireCrew, releaseCrew, nextFight,
} from "../logic/career.js";
import { garageOf, playerDef } from "../logic/garage.js";
import { assembleRobot } from "../logic/build.js";
import { effectiveStats } from "../logic/condition.js";
import { mpsToMph } from "../core/units.js";

const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
const HOW = [["", "Leave"], ["patch", "Patch"], ["repair", "Repair"], ["replace", "Replace"]];
const STATUS_NAMES = { ok: "OK", impaired: "worn", critical: "critical", failed: "destroyed" };

/**
 * @param ctx { app, reg, esc, showDef, career(), save(), done() }
 */
export function makePit(ctx) {
  const { app, reg, esc } = ctx;
  let plan = {};
  let note = "";

  const career = () => ctx.career();

  function open() {
    plan = pitAutoPlan(reg, career());     // start from the crew's own plan
    note = "";
    render();
  }

  function render() {
    const c = career();
    const st = pitState(reg, c);
    const q = pitQuote(reg, c, plan);
    const damaged = st.report.filter((r) => r.damaged);
    const nf = c.seasonOver ? null : nextFight(reg, c);
    const g = garageOf(reg, c);
    const cfg = crewConfig(reg);
    const n = crewSize(reg, c);
    const fee = cfg.hireFee[Math.min(cfg.hireFee.length - 1, n - cfg.base)];
    const pctMin = Math.min(1.2, q.minutes / Math.max(1, st.crewMinutes));
    app.innerHTML = `
      <div class="screen pit">
        <header class="bar">
          <button class="back" id="pit-back">Career</button>
          <div class="bar-title">The pit</div>
          <div class="bar-hint">${st.window} minutes until ${nf ? `the next fight` : "you are called"} · crew of ${n} · <b>${money(c.cash)}</b></div>
        </header>
        <div class="pit-main">
          <section class="pit-left">
            <canvas class="stage pit-stage" id="pit-stage"></canvas>
            <div class="pit-cap"><div class="feat-name">${esc(g.name)}</div><div class="feat-meta">${damaged.length ? `${damaged.length} part${damaged.length > 1 ? "s" : ""} damaged` : "Not a scratch on it"}</div></div>
            <div class="pit-effect" id="pit-effect">${effectHtml(st, q)}</div>
          </section>
          <section class="pit-right">
            ${damaged.length ? `
            <table class="pit-table">
              <tr><th>Part</th><th>Condition</th><th>Work</th></tr>
              ${damaged.map((r) => rowHtml(r)).join("")}
            </table>` : `<p class="muted">Nothing to fix. Send it out.</p>`}
            <div class="pit-crew">
              <div><b>Pit crew: ${n}</b> <span class="muted">(${cfg.base} free${n > cfg.base ? `, ${n - cfg.base} on ${money(cfg.salaryPerSeason)} a season each` : ""})</span></div>
              <div class="muted small">Each crew member adds ${st.window} crew-minutes to every pit stop.</div>
              <div class="pit-crew-btns">
                <button class="ghost tiny" id="pit-hire"${n >= cfg.max ? " disabled" : ""}>${n >= cfg.max ? "Crew is full" : `Hire one (${money(fee)} + ${money(cfg.salaryPerSeason)}/season)`}</button>
                <button class="ghost tiny" id="pit-release"${n <= cfg.base ? " disabled" : ""}>Let one go</button>
              </div>
            </div>
          </section>
        </div>
        <footer class="pit-foot">
          <div class="pit-meter${q.minutes > st.crewMinutes ? " over" : ""}">
            <div class="ws-weight-bar"><div style="width:${(pctMin / 1.2 * 100).toFixed(1)}%"></div><span class="cap" style="left:${(1 / 1.2 * 100).toFixed(1)}%"></span></div>
            <div class="ws-weight-num"><b>${q.minutes}</b> / ${st.crewMinutes} crew-min</div>
          </div>
          <div class="pit-money">Work ${money(q.cost)}${q.salvage ? ` · salvage +${money(q.salvage)}` : ""} · <b>net ${money(q.net)}</b></div>
          <div class="pit-btns">
            ${q.problems.length ? `<span class="neg small">${esc(q.problems[0])}</span>` : note ? `<span class="small">${esc(note)}</span>` : ""}
            <button class="ghost" id="pit-auto">Crew's plan</button>
            <button class="ghost" id="pit-skip">Leave it all</button>
            <button class="fight small" id="pit-go"${q.ok ? "" : " disabled"}>Send it out</button>
          </div>
        </footer>
      </div>`;
    wire();
    // The robot as it stands, damage showing (the canvas is new each render).
    ctx.showDef("pit-stage", playerDef(reg, c), { angle: 0.75 }, [{ ...(g.condition || {}) }]);
  }

  function rowHtml(r) {
    const pct = Math.round(r.condition * 100);
    const opt = (how) => r.options[how];
    return `
      <tr class="pit-row ${r.status}">
        <td><div class="pit-part">${r.unit ? `<span class="muted">${esc(r.unit)}:</span> ` : ""}${esc(r.name)}</div><div class="muted small">${esc(r.key)}${r.totaled ? ` · <span class="neg">totaled - replace it</span>` : r.replaceCheaper ? ` · <span class="pos">replacing is cheaper</span>` : ""}</div></td>
        <td><div class="pit-bar"><div style="width:${pct}%"></div></div><div class="small">${pct}% · ${STATUS_NAMES[r.status] || r.status}</div></td>
        <td class="pit-opts">${HOW.map(([how, label]) => {
          const o = how ? opt(how) : { cost: 0, minutes: 0 };
          if (!o) return "";
          const on = (plan[r.key] || "") === how;
          const sub = !how ? "fight with it" : how === "replace" ? `${o.spare ? "spare" : money(o.cost)} · ${o.minutes}m` : `${money(o.cost)} · ${o.minutes}m`;
          return `<button class="pit-opt${on ? " on" : ""}" data-key="${esc(r.key)}" data-how="${how}"><b>${label}</b><span>${sub}</span></button>`;
        }).join("")}</td>
      </tr>`;
  }

  /** What the robot will be like in the next fight: as it is, and after this plan. */
  function effectHtml(st, q) {
    const c = career();
    const asIs = st.assembled;
    const after = assembleRobot(reg, playerDef(reg, c));
    Object.assign(after.condition, q.condition);
    const e0 = effectiveStats(asIs, reg.rules), e1 = effectiveStats(after, reg.rules);
    const rated = asIs.stats;
    const armour = (a) => Math.round(a.fittings.filter((f) => f.part.category === "armor").reduce((t, f) => t + f.part.hp * (a.condition[f.key] ?? 1), 0));
    const pct = (x, of) => (of ? `${Math.round((x / of) * 100)}%` : "-");
    const rows = [
      ["Top speed", `${mpsToMph(e0.topSpeedMps).toFixed(1)} mph`, `${mpsToMph(e1.topSpeedMps).toFixed(1)} mph`, `${rated.topSpeedMph.toFixed(1)}`],
      ["Drive force", pct(e0.tractiveForceN, rated.forcePerWheelN * rated.drivenWheels), pct(e1.tractiveForceN, rated.forcePerWheelN * rated.drivenWheels), "100%"],
      ["Weapon", rated.weapon.energyJ ? pct(e0.weapon.energyJ, rated.weapon.energyJ) : "-", rated.weapon.energyJ ? pct(e1.weapon.energyJ, rated.weapon.energyJ) : "-", "100%"],
      ["Armour", `${armour(asIs)} hp`, `${armour(after)} hp`, `${Math.round(rated.armorHp)}`],
    ];
    const warn = e1.immobile ? `<div class="ws-err">It cannot drive like this: the next fight is lost before it starts. Fix the ${e1.chassisGone ? "chassis" : e1.electronicsGone ? "electronics" : e1.wheelCount <= 0 ? "wheels" : "drive"}.</div>`
      : e1.weapon.dead && rated.weapon.energyJ ? `<div class="ws-warn">The weapon is dead for the next fight.</div>` : "";
    return `
      <div class="scout-sub">In the next fight</div>
      <table class="ledger pit-fx"><tr><td></td><td class="muted">as it is</td><td class="muted">after this work</td></tr>
        ${rows.map(([k, a, b]) => `<tr><td>${k}</td><td>${a}</td><td><b>${b}</b></td></tr>`).join("")}</table>
      ${warn}`;
  }

  function wire() {
    document.getElementById("pit-back").addEventListener("click", () => ctx.done(false));
    document.querySelectorAll(".pit-opt").forEach((b) => b.addEventListener("click", () => actions.choose(b.dataset.key, b.dataset.how)));
    document.getElementById("pit-auto").addEventListener("click", () => actions.auto());
    document.getElementById("pit-skip").addEventListener("click", () => actions.skip());
    document.getElementById("pit-go").addEventListener("click", () => actions.go());
    document.getElementById("pit-hire").addEventListener("click", () => actions.hire());
    document.getElementById("pit-release").addEventListener("click", () => actions.release());
  }

  // Everything a button does - the headless menu check drives these.
  const actions = {
    open,
    choose(key, how) { if (how) plan = { ...plan, [key]: how }; else { plan = { ...plan }; delete plan[key]; } render(); },
    auto() { plan = pitAutoPlan(reg, career()); note = "The crew's plan: what stops it driving first, then the weapon, then armour."; render(); },
    go() {
      const r = doPit(reg, career(), plan);
      if (!r.ok) { note = r.errors[0]; render(); return r; }
      ctx.save();
      ctx.done(true);
      return r;
    },
    skip() { skipPit(career()); ctx.save(); ctx.done(true); },
    hire() { const r = hireCrew(reg, career()); note = r.ok ? `Signed a crew member for ${money(r.fee)}.` : r.reason; ctx.save(); render(); },
    release() { releaseCrew(reg, career()); ctx.save(); render(); },
    get plan() { return plan; },
  };

  return { actions, open };
}
