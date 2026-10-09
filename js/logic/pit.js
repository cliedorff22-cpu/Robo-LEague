// pit.js - between fights: what is broken, what fixing it costs in money and
// in crew time, and what gets done before the next fight.
//
// Damage no longer disappears after a fight (it did until Stage 7). Every
// robot - the player's and the AI teams' - carries its part condition from
// fight to fight, and the time between fights is the PIT WINDOW: the crew
// gets `window x crew size` crew-minutes to work with. Whatever is not fixed
// fights damaged, and condition.js turns that into a slower, weaker robot.
//
// For each damaged part (a FITTING - the left and right panels are separate):
//   patch    get it back to `patchTo` (60%): quick and dirty - fewer minutes
//            per hp than a proper job, same parts cost per hp
//   repair   back to 100%. A part below `totaledBelow` is TOTALED - mangled
//            past repairing - and can only be replaced. One whose repair would
//            cost `totaledRepairCostRatio` of a new one can still be repaired,
//            but the pit says a replacement is the better buy
//   replace  swap in a fresh one - a spare from the garage if there is one,
//            otherwise bought from the shop - in a fixed number of minutes by
//            category; the old part is scrapped for `salvageCreditFraction`
//            of its value as it stands
//
// Pure logic over plain data (rules.json `pit`, parts.json repairCostPerHp
// and repairMinPerHp), so the AI teams' pits, the player's, the season
// simulator and the tests all use the same arithmetic.

import { assembleRobot } from "./build.js";
import { partStatus } from "./condition.js";

/** The order a crew works in when it cannot do everything: what stops you driving first. */
export const PRIORITY = ["electronics", "chassis", "drive", "motor", "battery", "wheel", "weaponMotor", "weapon", "srimech", "armor"];

export function pitConfig(reg) {
  const p = reg.rules.pit || {};
  return {
    totaledBelow: 0.1,
    totaledRepairCostRatio: 0.75,
    salvageCreditFraction: 0.4,
    patchTo: 0.6,
    patchMinutesFactor: 0.55,
    windows: { group: 60, final: 30, giantNutGroup: 45, giantNutFinal: 25 },
    replaceMinutes: { chassis: 120, drive: 35, motor: 25, battery: 8, electronics: 15, wheel: 10, weaponMotor: 25, weapon: 20, srimech: 15, armor: 12 },
    aiCrew: { rookie: 2, pro: 3, elite: 4, world: 5 },
    offseasonRepairRate: 0.5,
    ...p,
    windows: { group: 60, final: 30, giantNutGroup: 45, giantNutFinal: 25, ...(p.windows || {}) },
    replaceMinutes: { chassis: 120, drive: 35, motor: 25, battery: 8, electronics: 15, wheel: 10, weaponMotor: 25, weapon: 20, srimech: 15, armor: 12, ...(p.replaceMinutes || {}) },
    aiCrew: { rookie: 2, pro: 3, elite: 4, world: 5, ...(p.aiCrew || {}) },
  };
}

/** Minutes until the next fight after a fight at this stage of a season. */
export function pitWindow(reg, fixture) {
  const w = pitConfig(reg).windows;
  if (!fixture) return w.group;
  const gn = fixture.league === "giantNut";
  if (fixture.stage === "final") return gn ? w.giantNutFinal : w.final;
  return gn ? w.giantNutGroup : w.group;
}

/** Labour on top of the parts price for every repair (economy.json repairs). */
const labourOf = (reg) => reg.economy?.repairs?.labourMultiplier ?? 1;

/**
 * Every fitting, with what each way of fixing it would take.
 * @param assembled  the robot with its current condition
 * @param ctx { spares: {partId: n} the garage holds, price(partId) to buy one,
 *              discount 0..1 off repairs }
 */
export function pitReport(reg, assembled, ctx = {}) {
  const cfg = pitConfig(reg);
  const th = reg.rules.damage.thresholds;
  // Labour, less the career's parts discount (sponsors, Giant Nut deals).
  const labour = labourOf(reg) * (1 - (ctx.discount || 0));
  const spares = ctx.spares || {};
  const price = ctx.price || ((id) => reg.part(id).cost);
  return assembled.fittings.map((f) => {
    const p = f.part;
    const c = clamp01(assembled.condition[f.key] ?? 1);
    const hpLost = p.hp * (1 - c);
    const row = {
      key: f.key, partId: p.id, name: p.name, category: p.category, condition: c,
      status: partStatus(c, th), damaged: c < 0.999, options: {},
    };
    if (!row.damaged) return row;
    const fullCost = Math.round(hpLost * p.repairCostPerHp * labour);
    row.totaled = c < cfg.totaledBelow;
    row.replaceCheaper = fullCost >= cfg.totaledRepairCostRatio * p.cost;
    if (c < cfg.patchTo) {
      const hp = p.hp * (cfg.patchTo - c);
      row.options.patch = { to: cfg.patchTo, cost: Math.round(hp * p.repairCostPerHp * labour), minutes: Math.ceil(hp * p.repairMinPerHp * cfg.patchMinutesFactor) };
    }
    if (!row.totaled) row.options.repair = { to: 1, cost: fullCost, minutes: Math.ceil(hpLost * p.repairMinPerHp) };
    const spare = (spares[p.id] || 0) > 0;
    row.options.replace = {
      to: 1, spare, cost: spare ? 0 : price(p.id), minutes: cfg.replaceMinutes[p.category] ?? 20,
      salvage: Math.round(cfg.salvageCreditFraction * p.cost * c),
    };
    return row;
  });
}

/**
 * What a set of choices adds up to. `plan` = { fittingKey: "patch" | "repair" | "replace" }.
 * @returns { cost, salvage, net, minutes, condition (after), replaced: [partId], sparesUsed: {id: n}, bought: {id: n} }
 */
export function planTotals(reg, assembled, plan, ctx = {}) {
  const report = pitReport(reg, assembled, ctx);
  const condition = { ...assembled.condition };
  const sparesLeft = { ...(ctx.spares || {}) };
  const out = { cost: 0, salvage: 0, minutes: 0, condition, replaced: [], sparesUsed: {}, bought: {}, lines: [] };
  for (const row of report) {
    const how = plan[row.key];
    if (!how || !row.damaged) continue;
    let opt = row.options[how];
    if (!opt) continue;
    if (how === "replace") {
      // Spares are shared: two damaged panels and one spare means one buys.
      const spare = (sparesLeft[row.partId] || 0) > 0;
      opt = { ...opt, spare, cost: spare ? 0 : (ctx.price ? ctx.price(row.partId) : reg.part(row.partId).cost) };
      if (spare) { sparesLeft[row.partId]--; out.sparesUsed[row.partId] = (out.sparesUsed[row.partId] || 0) + 1; }
      else out.bought[row.partId] = (out.bought[row.partId] || 0) + 1;
      out.salvage += opt.salvage;
      out.replaced.push(row.partId);
    }
    out.cost += opt.cost;
    out.minutes += opt.minutes;
    condition[row.key] = Math.max(row.condition, opt.to);
    out.lines.push({ key: row.key, name: row.name, how, cost: opt.cost, minutes: opt.minutes, salvage: how === "replace" ? opt.salvage : 0, spare: !!opt.spare });
  }
  out.net = out.cost - out.salvage;
  return out;
}

/**
 * The crew's best effort with `crewMinutes` and `cash`: what stops the robot
 * driving first, then the weapon, then armour; the worst damage first within
 * each; a full repair where it fits, a patch where it does not, a replacement
 * for anything totaled.
 */
export function autoPlan(reg, assembled, { crewMinutes = Infinity, cash = Infinity, ctx = {}, prefer = null } = {}) {
  // `prefer` (ailearn.js pitPrefer): what the NEXT opponent will go for - the
  // armour on the faces it hits, a self-righter against a flipper - moves up
  // the list, ahead of the weapon.
  const faceOf = (r) => (r.category === "armor" ? reg.part(r.partId).spec.slot : null);
  const rank = (r) => {
    if (prefer?.categories?.includes(r.category)) return 4.5;
    if (r.category === "armor" && prefer?.faces?.includes(faceOf(r))) return 5.5 - prefer.faces.indexOf(faceOf(r)) * 0.1;
    return PRIORITY.indexOf(r.category);
  };
  const report = pitReport(reg, assembled, ctx)
    .filter((r) => r.damaged)
    .sort((a, b) => rank(a) - rank(b) || a.condition - b.condition);
  const plan = {};
  let minutes = 0, money = 0;
  const spares = { ...(ctx.spares || {}) };
  for (const r of report) {
    // Totaled: replace or nothing. Otherwise the cheaper proper fix first,
    // then a patch if time is short.
    const choices = r.totaled ? ["replace"] : r.replaceCheaper ? ["replace", "repair", "patch"] : ["repair", "patch", "replace"];
    for (const how of choices) {
      const o = r.options[how];
      if (!o) continue;
      const spare = how === "replace" && (spares[r.partId] || 0) > 0;
      const cost = how === "replace" ? (spare ? 0 : o.cost) : o.cost;
      // Do not replace a part just because a repair did not fit, unless it is
      // something the robot cannot fight without.
      if (how === "replace" && !r.totaled && !r.replaceCheaper && r.status !== "failed" && r.status !== "critical") continue;
      if (minutes + o.minutes > crewMinutes || money + cost > cash) continue;
      plan[r.key] = how;
      minutes += o.minutes; money += cost;
      if (spare) spares[r.partId]--;
      break;
    }
  }
  return plan;
}

/**
 * An AI team's pit after a fight: its crew (by league) works through the
 * window. Teams pay from their own budgets, which the career does not track
 * fight by fight - only their time is limited.
 * @param conditions  [per unit condition map] -> returns the same shape, repaired
 */
export function aiPit(reg, def, conditions, windowMinutes, prefer = null) {
  const cfg = pitConfig(reg);
  const crew = cfg.aiCrew[def.league] ?? 2;
  return conditions.map((cond, i) => {
    if (!cond) return cond;
    const a = i === 0 ? assembleRobot(reg, def) : null;
    if (!a) return {};   // a multibot's second unit is rebuilt whole between fights
    Object.assign(a.condition, cond);
    // AI crews always have the spare they need (it is in their trailer).
    const spares = Object.fromEntries(a.fittings.map((f) => [f.part.id, 9]));
    const plan = autoPlan(reg, a, { crewMinutes: windowMinutes * crew, ctx: { spares }, prefer });
    return pruneFresh(planTotals(reg, a, plan, { spares }).condition);
  });
}

/** A condition map with the factory-fresh fittings dropped (keeps saves small). */
export function pruneFresh(cond) {
  const out = {};
  for (const [k, v] of Object.entries(cond || {})) if (v < 0.999) out[k] = Math.round(v * 1000) / 1000;
  return out;
}

/** One line on how battered a robot is, for scouting and the hub. */
export function damageSummary(reg, assembled) {
  const th = reg.rules.damage.thresholds;
  const hurt = assembled.fittings
    .map((f) => ({ name: f.part.name, category: f.part.category, c: assembled.condition[f.key] ?? 1 }))
    .filter((x) => x.c < 0.95)
    .sort((a, b) => a.c - b.c);
  return {
    fresh: hurt.length === 0,
    worst: hurt.slice(0, 3).map((x) => ({ ...x, status: partStatus(x.c, th) })),
    count: hurt.length,
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
