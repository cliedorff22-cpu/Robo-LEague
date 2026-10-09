// career.js - the player's career: seasons in a row, money, sponsors,
// trophies and the save file.
//
// Pure logic over plain JSON (the whole career IS the save file - see
// serialize()). The season formats are season.js; the money is
// data/economy.json; AI-vs-AI fights go to the fast resolver. The player's own
// fights are either fought in the arena (fight.html hands the result back) or
// simulated with the resolver if they would rather not.
//
// Until the Stage 7 pit, the robot is repaired in full after every fight and
// the bill is paid there and then - which is already where the money pressure
// comes from.

import { makeRng, hashSeed } from "../core/rng.js";
import { assembleRobot, assemblePartner } from "./build.js";
import { conditionReport, repairBill } from "./condition.js";
import { resolveFight } from "./resolver.js";
import { makeSeason, advance, playerFixture, recordResult, robotFinish, nextMembership, groupTables } from "./season.js";
import { evolvedDef, evolveField, versionOf } from "./evolution.js";
import { newGarage, playerDef, discountOf, garageOf, spares, priceOf } from "./garage.js";
import { pitReport, planTotals, autoPlan, aiPit, pitWindow, pitConfig, pruneFresh } from "./pit.js";
import { prepareFor, learnFromFight, pitPrefer } from "./ailearn.js";
import { difficultyOf } from "./settings.js";
import { ageField, seedDrivers, registerCareerRobots, adoptRobot } from "./field.js";
import { serviceLoans } from "./market.js";
import { recordTape } from "./scouting.js";
import { weaponClassOf } from "./workshop.js";
import { pay } from "./ledger.js";
import { careerArena } from "./arenas.js";
import { roundName } from "./tournament.js";
import {
  recordMeeting, coolRivalries, carryRivalries, rivalPrep, rivalGate, grudgePurse, grudgeFixture, maybeCallOut, levelOf, rivalOf,
} from "./rivalry.js";

export const CAREER_SCHEMA = "career/1";
// 2: the Stage 6 garage (the player's own robot and parts) - see garage.js.
// 3: Stage 7 - damage carries between fights (`wear`, garage.condition), the
//    pit, the crew, per-robot records and retired robots.
// 4: the living field - drivers age and retire, new teams join (field.js),
//    AI memory (ailearn.js), difficulty and the player's multibot.
// 5: rivalries - head-to-head records, grudge matches, call-outs (rivalry.js).
// 6: loans and trading - bank loans, the paddock market, robots sold to AI
//    teams (market.js).
export const CAREER_VERSION = 6;
export { registerCareerRobots };

/** A fresh career: the player in the bottom league with the starting cash. */
export function newCareer(reg, { seed = 1, team = "Your Team", startingCash = null, difficulty = "medium" } = {}) {
  const field = reg.roster();
  const membership = Object.fromEntries(field.map((r) => [r.id, r.league]));
  // The player starts at the bottom, whatever their robot file says.
  membership[reg.playerId] = reg.league.leagues[0];
  const career = {
    schema: CAREER_SCHEMA, version: CAREER_VERSION,
    seed, team,
    playerId: reg.playerId,
    cash: startingCash ?? reg.economy.startingCash,
    difficulty,              // Settings -> Difficulty; the menus keep it in step (settings.js)
    ledger: [],
    sponsors: [],            // ids signed, league kind
    perks: [],               // Giant Nut deals: { id, partsDiscount, until (season index) }
    unlocks: [],
    membership,
    seasonIndex: 0,
    season: null,
    history: [],
    trophies: [],            // league titles
    giantNutHistory: [],     // its own record and trophy case
    evolution: {},           // every other robot's off-season changes (evolution.js)
    offseason: null,         // the last off-season's report
    stats: { fights: 0, wins: 0, losses: 0, kos: 0, koLosses: 0, damageDealt: 0, streak: 0, bestStreak: 0, fastestKoS: null, mostDamage: 0 },
    wear: {},                // every AI robot's damage as it stands: id -> [per unit condition]
    crew: { size: null },    // pit crew (null = economy.json crew.base)
    pit: null,               // the open pit after the player's last fight
    lastFight: null,
    notices: [],
    garage: newGarage(reg),  // the player's robot and parts (garage.js)
    drivers: {},             // every AI robot's driver: name, career span, seasons driven (field.js)
    robotLife: {},           // and each robot's working life
    newcomers: {},           // robots that joined the field during this career
    retired: [],             // who has retired, and when
    ai: {},                  // what every AI team has learned (ailearn.js)
    rivals: {},              // every robot's history against the player (rivalry.js)
    grudge: null,            // a booked grudge match: fought before the next fight
    challenge: null,         // a rival's call-out, waiting for an answer
    grudgeLog: [],           // grudge matches fought
    loans: [],               // bank loans (market.js)
    tape: {},                // every robot's last fight, for the scouts (scouting.js)
    market: null,            // today's paddock market
    robotSales: [],          // robots the player sold to AI teams
  };
  seedDrivers(reg, career);
  startSeason(reg, career);
  return career;
}

/** What kind of season number `index` is: the cycle in data/league.json. */
export const seasonKind = (reg, index) => reg.league.cycle[(index - 1) % reg.league.cycle.length];

/** The league the player is in now. */
export const playerLeague = (career) => career.membership[career.playerId];

function startSeason(reg, career) {
  career.seasonIndex++;
  // Seeded by how good each driver is now (evolution and the field move them).
  const ratings = Object.fromEntries(Object.keys(career.membership).map((id) => [id, id === career.playerId ? reg.robot(id).rating : fieldedDef(reg, career, id).rating]));
  career.season = makeSeason(reg.league, {
    index: career.seasonIndex, kind: seasonKind(reg, career.seasonIndex),
    membership: career.membership, ratings, seed: career.seed,
  });
  // Sponsors pay their retainer at the start of every league season.
  if (career.season.kind === "league") {
    for (const id of career.sponsors) {
      const sp = sponsor(reg, id);
      if (sp?.retainer) pay(career, sp.retainer, `${sp.name} retainer`);
    }
  }
  career.perks = career.perks.filter((p) => p.until >= career.seasonIndex);
  // The banks take their payment, interest first (market.js).
  for (const p of serviceLoans(reg, career)) {
    career.notices.push({ kind: p.owed ? "relegation" : "sponsor", text: p.owed
      ? `${p.name} took a $${p.payment.toLocaleString()} loan payment. You still owe $${p.owed.toLocaleString()}.`
      : `${p.name}: your loan is paid off.` });
  }
}

const sponsor = (reg, id) => reg.economy.sponsors.find((s) => s.id === id);


/**
 * The robot def a robot fights as this season: its latest version (the
 * off-season's upgrades, js/logic/evolution.js) in whatever league it is in now.
 */
export function fieldedDef(reg, career, id) {
  // The player fights whatever they built in the workshop.
  const def = id === career.playerId ? playerDef(reg, career) : evolvedDef(reg, career, id);
  const out = { ...def, league: career.membership[id] ?? def.league };
  // Every AI driver learns at the difficulty's rate (ailearn.js, ai.js).
  if (id !== career.playerId) out.learnRate = careerDifficulty(reg, career).learnRate;
  return out;
}
export { versionOf };

/** A seed for one fixture, the same every time the save is loaded. */
export const fixtureSeed = (career, fixture) => hashSeed(`${career.seed}:${fixture.id}`) & 0x7fffffff;

/** Resolve a fight with the fast resolver, compacted for the season record. */
export function resolveFixture(reg, career, aId, bId, fixture) {
  // Both teams set their robots up for this opponent - from what they have
  // learned, without trial fights (ailearn.js) - then fight, then learn.
  const da = fieldedDef(reg, career, aId), db = fieldedDef(reg, career, bId);
  const pa = prepareFor(reg, career, aId, da, db, { depth: 0, salt: fixture.id });
  const pb = prepareFor(reg, career, bId, db, da, { depth: 0, salt: fixture.id });
  const r = resolveFight(reg, pa.def, pb.def, {
    seed: fixtureSeed(career, fixture), conditionA: wearOf(reg, career, aId), conditionB: wearOf(reg, career, bId),
  });
  for (const [id, me, them] of [[aId, da, db], [bId, db, da]]) {
    learnFromFight(career, id, { oppClass: weaponClassOf(reg, them.build), won: r.winnerId === id, method: r.method, cause: r.cause, learnRate: me.learnRate });
  }
  for (const id of [aId, bId]) afterFight(reg, career, id, r.sides[id].condition, fixture);
  const out = compactResult(r, { [aId]: r.sides[aId].damageScore, [bId]: r.sides[bId].damageScore }, "sim");
  // The tape the scouts keep: every robot's last fight (scouting.js).
  recordTape(reg, career, career.season, fixture, out);
  return out;
}

/** What the difficulty setting does, as the career stands. */
export const careerDifficulty = (reg, career) => difficultyOf(reg, career.difficulty || "medium");

/** The robot a team will meet next this season (the group draw is known), or null. */
function nextOpponentOf(career, id) {
  const f = (career.season?.fixtures || []).find((x) => !x.result && (x.a === id || x.b === id));
  return f ? (f.a === id ? f.b : f.a) : null;
}

/** The damage a robot brings to its next fight: [per unit condition map], or null if fresh. */
export function wearOf(reg, career, id) {
  if (id === career.playerId) {
    const g = garageOf(reg, career);
    const c = g.condition || {}, pc = g.partnerCondition || {};
    if (!Object.keys(c).length && !Object.keys(pc).length) return null;
    return g.partner ? [c, pc] : [c];
  }
  return career.wear?.[id] || null;
}

/**
 * After a fight: an AI team's crew works through its pit window and the
 * robot carries what is left into its next fight. The player's robot keeps
 * its damage until the player's own pit (doPit).
 */
function afterFight(reg, career, id, conditions, fixture) {
  if (!conditions) return;
  if (id === career.playerId) {
    const g = garageOf(reg, career);
    g.condition = pruneFresh(conditions[0]);
    if (g.partner) g.partnerCondition = pruneFresh(conditions[1] || {});
    return;
  }
  career.wear ||= {};
  // The crew fixes first what its next opponent will go for.
  const next = nextOpponentOf(career, id);
  const prefer = next ? pitPrefer(weaponClassOf(reg, fieldedDef(reg, career, next).build)) : null;
  const left = aiPit(reg, fieldedDef(reg, career, id), conditions, pitWindow(reg, fixture), prefer).map(pruneFresh);
  if (left.some((c) => Object.keys(c).length)) career.wear[id] = left;
  else delete career.wear[id];
}

/** What a season keeps of a fight. */
export function compactResult(r, damage, by) {
  return {
    winnerId: r.winnerId, loserId: r.loserId, method: r.method, cause: r.cause ?? null,
    elapsedS: Math.round(r.elapsedS ?? 0), decision: r.decision ?? null, votes: r.votes ?? null,
    damage, by,
  };
}

/**
 * Run the season on until the player has a fight to fight. When the season
 * ends (the last final is fought, or the player is out and the rest is
 * simulated) it is closed - prize money, movement, history - and the career
 * waits for startNextSeason(), so the end-of-season screen can be shown.
 * @returns every fight resolved, in order
 */
export function advanceCareer(reg, career) {
  if (career.season.done) return [];
  const log = advance(career.season, reg.league, {
    resolve: (a, b, f) => resolveFixture(reg, career, a, b, f),
    playerId: career.playerId,
  });
  if (career.season.done) {
    closeSeason(reg, career);
    career.seasonOver = true;
  }
  return log;
}

/**
 * Robots the player sold (market.js) join the field: each buying team races
 * it from now on in place of its own robot - or, if that robot has gone
 * since, in place of the weakest robot in the same league.
 */
function deliverSales(reg, career, report) {
  for (const sale of career.robotSales || []) {
    if (sale.status !== "pending") continue;
    let oldId = sale.buyerId in career.membership ? sale.buyerId : null;
    if (!oldId) {
      const lg = reg.league.leagues[0];
      oldId = Object.keys(career.membership).filter((id) => id !== career.playerId && career.membership[id] === lg)
        .sort((a, b) => (career.evolution?.[a]?.rating ?? reg.robot(a).rating) - (career.evolution?.[b]?.rating ?? reg.robot(b).rating))[0];
    }
    if (!oldId) continue;
    const team = reg.robot(oldId).team;
    const def = adoptRobot(reg, career, oldId, sale.def, career.season, report, `replaced by ${sale.def.name}, bought from you`);
    report.newRobots.push({ id: def.id, name: def.name, team, league: career.membership[def.id], replaces: reg.robot(oldId).name, replacesId: oldId, formerPlayer: true });
    Object.assign(sale, { status: "fielded", newId: def.id, team });
    career.notices.push({ kind: "rivalry", text: `${def.name}, the robot you sold, now races for ${team} in the ${LEAGUE_TITLES[career.membership[def.id]] || career.membership[def.id]} league.` });
  }
}

/** Open the next season once the player has seen how the last one ended. */
export function startNextSeason(reg, career) {
  if (!career.season.done) throw new Error("the season is still running");
  // The off-season: every other team works on its robot.
  const report = evolveField(reg, career, career.season, (id) => fieldedDef(reg, career, id));
  career.offseason = report;
  const rebuilt = report.moves.filter((m) => m.notes.some((n) => n.startsWith("rebuilt")));
  const upgraded = report.moves.filter((m) => m.notes.some((n) => !n.startsWith("driver") && !n.startsWith("rebuilt")));
  if (report.moves.length) {
    career.notices.push({ kind: "offseason", text: `Off-season: ${upgraded.length} teams upgraded their robots${rebuilt.length ? `, ${rebuilt.length} rebuilt from scratch` : ""}. See Results.` });
  }
  // The field moves on: drivers age and retire, robots are replaced, new
  // teams come up through Rookie, every league back to 30 (field.js).
  const fieldReport = ageField(reg, career, career.season);
  report.field = fieldReport;
  const r = fieldReport;
  if (r.retiredDrivers.length || r.newRobots.length) {
    const bits = [];
    if (r.retiredDrivers.length) bits.push(`${r.retiredDrivers.length} driver${r.retiredDrivers.length > 1 ? "s" : ""} retired (${r.retiredDrivers.slice(0, 3).map((d) => `${d.name} after ${d.years} seasons`).join(", ")}${r.retiredDrivers.length > 3 ? "..." : ""})`);
    const newTeams = r.newRobots.filter((x) => x.newTeam).length;
    if (newTeams) bits.push(`${newTeams} new team${newTeams > 1 ? "s" : ""} joined Rookie`);
    const replaced = r.newRobots.filter((x) => x.replaces).length;
    if (replaced) bits.push(`${replaced} robot${replaced > 1 ? "s" : ""} replaced by new designs`);
    career.notices.push({ kind: "offseason", text: `The field: ${bits.join("; ")}.` });
  }
  // Robots the player sold join their new teams (market.js).
  deliverSales(reg, career, fieldReport);
  // Feuds outlive robots: a team's new robot inherits the grudge (rivalry.js).
  for (const c of carryRivalries(reg, career, fieldReport, (id) => reg.robot(id).name)) {
    career.notices.push({ kind: "rivalry", text: `${c.name} replaces ${c.from} - and its team has not forgotten you.` });
  }
  coolRivalries(reg, career);
  offseasonRebuild(reg, career);
  career.seasonOver = false;
  startSeason(reg, career);
}

/** The player's next fight, with the opponent's scouting card data. */
export function nextFight(reg, career) {
  // A booked grudge match comes first: it is fought before the next fixture.
  const grudge = !career.seasonOver && career.grudge && career.grudge.oppId in career.membership ? grudgeFixture(career, (id) => career.membership[id]) : null;
  const f = grudge || playerFixture(career.season, career.playerId);
  if (!f) return null;
  const oppId = f.a === career.playerId ? f.b : f.a;
  const prep = opponentPrep(reg, career, f, oppId);
  // A grudge match is staged in the bigger of the two robots' venues.
  const order = reg.league.leagues;
  const venueLeague = grudge ? order[Math.max(order.indexOf(playerLeague(career)), order.indexOf(career.membership[oppId]))] : playerLeague(career);
  return {
    fixture: f, oppId, opp: prep.def, oppChanges: prep.changes, seed: fixtureSeed(career, f), grudge: !!grudge,
    // Where: the league's venue (the Giant Nut's in a Giant Nut season) and a
    // hazard layout from its rotation, fixed by the fixture.
    arena: careerArena(reg, { seasonKind: grudge ? "league" : career.season.kind, league: venueLeague, fixtureId: f.id }),
    // Both robots as they will turn up: whatever the pits did not fix.
    myCondition: wearOf(reg, career, career.playerId)?.[0] || {},
    myPartnerCondition: wearOf(reg, career, career.playerId)?.[1] || null,
    oppCondition: wearOf(reg, career, oppId),
  };
}

/**
 * The player's opponent sets its robot up for the player: it TESTS its
 * options in trial fights against the player's robot as it stands (damage
 * and all) - how many is the difficulty - and drives with what it has
 * learned against the player's weapon, at the difficulty's skill. Worked out
 * once per fixture and kept (career.prep), and again if the player changes
 * their robot or the difficulty.
 */
function opponentPrep(reg, career, f, oppId) {
  const diff = careerDifficulty(reg, career);
  const me = fieldedDef(reg, career, career.playerId);
  const sig = `${f.id}|${diff.level}|${levelOf(reg, rivalOf(career, oppId)).level}|${JSON.stringify(me.build)}|${JSON.stringify(me.body)}|${JSON.stringify(me.partner?.build || null)}`;
  if (career.prep?.sig === sig) return career.prep;
  // A rival studies you harder, and its driver is fired up (rivalry.js).
  const rv = rivalPrep(reg, career, oppId, { testing: !!diff.adaptOptions });
  const skillBonus = Math.round(((diff.skillBonus || 0) + rv.skill) * 1000) / 1000;
  const base = { ...fieldedDef(reg, career, oppId), skillBonus };
  const cond = { [career.playerId]: wearOf(reg, career, career.playerId), [oppId]: wearOf(reg, career, oppId) };
  const depth = Math.min(10, (diff.adaptOptions || 0) + rv.extraOptions);
  const p = prepareFor(reg, career, oppId, base, me, { depth, fights: diff.adaptFights || 12, salt: f.id, cond, explore: diff.adaptOptions ? 0 : 0.15 });
  career.prep = { sig, fixtureId: f.id, oppId, def: { ...p.def, skillBonus }, changes: p.changes };
  return career.prep;
}

/**
 * Record the player's fight.
 * @param result  { winnerId, method, cause, elapsedS, decision, votes, damage: { id: n } }
 * @param condition  the player's fitting condition after the fight (the arena
 *                   or the resolver); it stays on the robot until the pit
 * @param oppCondition  the opponent's units' condition after it (the arena)
 * @param oppLearned    what the opponent's driver learned in the fight (the arena)
 * @returns the fight summary the results screen shows
 */
export function applyPlayerResult(reg, career, fixtureId, result, condition = null, oppCondition = null, oppLearned = null) {
  const nf = nextFight(reg, career);
  if (!nf || nf.fixture.id !== fixtureId) throw new Error(`no pending fight ${fixtureId}`);
  const f = nf.fixture;
  // A grudge match is outside the standings: it goes in the rivalry's book.
  const grudge = f.stage === "grudge";
  if (!grudge) recordResult(career.season, f, result);
  recordTape(reg, career, career.season, f, result);
  // A call-out nobody answered lapses when the next fight is fought.
  career.challenge = null;

  const me = career.playerId;
  const won = result.winnerId === me;
  const ko = result.method === "ko" || result.method === "tapout";
  const s = career.stats;
  s.fights++; won ? s.wins++ : s.losses++;
  if (won && ko) s.kos++;
  if (!won && ko) s.koLosses++;
  s.damageDealt += result.damage?.[me] ?? 0;
  // Records, for the Hall of Fame.
  s.streak = won ? (s.streak || 0) + 1 : 0;
  s.bestStreak = Math.max(s.bestStreak || 0, s.streak);
  if (won && result.method === "ko" && (s.fastestKoS == null || result.elapsedS < s.fastestKoS)) s.fastestKoS = result.elapsedS;
  s.mostDamage = Math.max(s.mostDamage || 0, result.damage?.[me] ?? 0);
  const g = garageOf(reg, career);
  const rec = (g.record ||= { fights: 0, wins: 0, kos: 0, titles: 0, since: career.seasonIndex });
  rec.fights++; if (won) rec.wins++; if (won && ko) rec.kos++;

  // The opponent remembers the fight (ailearn.js).
  learnFromFight(career, nf.oppId, {
    oppClass: weaponClassOf(reg, fieldedDef(reg, career, me).build), won: !won, method: result.method, cause: result.cause,
    learned: oppLearned, learnRate: careerDifficulty(reg, career).learnRate,
  });
  career.prep = null;

  // Purses, scaled by the difficulty.
  const econ = reg.economy;
  const gn = career.season.kind === "giantNut" && !grudge;
  const scale = careerDifficulty(reg, career).purse ?? 1;
  const order = reg.league.leagues;
  const bigger = order[Math.max(order.indexOf(playerLeague(career)), order.indexOf(career.membership[nf.oppId] ?? playerLeague(career)))];
  const base = grudge ? grudgePurse(reg, career, nf.oppId, econ.league[bigger]) : gn ? econ.giantNut : econ.league[playerLeague(career)];
  const purse = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * scale) : v]));
  const before = career.cash;
  const ledgerStart = career.ledger.length;
  // The promoters pay extra for a rivalry, as it stood coming in.
  const gate = grudge ? 0 : rivalGate(reg, career, nf.oppId, purse.appearance);
  if (grudge) {
    pay(career, purse.appearance, "Grudge match appearance fee");
    if (won) pay(career, purse.win, "Grudge match purse");
    if (won && ko) pay(career, purse.koBonus, "Knockout bonus");
  } else {
    pay(career, purse.appearance, gn ? "Giant Nut appearance fee" : "Appearance fee");
    if (gate) pay(career, gate, `${levelOf(reg, rivalOf(career, nf.oppId)).name} gate bonus`);
    if (won) {
      pay(career, gn && f.stage === "group" ? purse.groupWin : gn ? 0 : purse.win, gn ? "Giant Nut group win" : "Win purse");
      if (ko) pay(career, purse.koBonus, "Knockout bonus");
      if (!gn) for (const id of career.sponsors) { const sp = sponsor(reg, id); if (sp?.perWin) pay(career, sp.perWin, `${sp.name} win bonus`); }
    }
  }

  // The rivalry: another page in the book (rivalry.js).
  const bracket = f.stage === "final" ? (f.league === "giantNut" ? career.season.giantNut.bracket : career.season.leagues[f.league]?.finals) : null;
  const meeting = recordMeeting(reg, career, nf.oppId, {
    won, result, fixture: f, grudge,
    titleFight: !!bracket && f.bracketRound === bracket.rounds.length - 1,
    stageName: bracket ? `${f.league === "giantNut" ? "Giant Nut " : `${LEAGUE_TITLES[f.league] || f.league} `}${roundName(bracket, f.bracketRound).toLowerCase()}` : null,
    eliminated: !!bracket,
    myTier: order.indexOf(playerLeague(career)), oppTier: order.indexOf(career.membership[nf.oppId] ?? playerLeague(career)),
    driver: career.drivers?.[nf.oppId]?.name || null,
  });
  const oppName = reg.robot(nf.oppId).name;
  if (meeting.levelUp) {
    const lv = levelOf(reg, meeting.entry).level;
    career.notices.push({ kind: "rivalry", text: lv === 1 ? `A rivalry is born: you and ${oppName}.` : lv === 2 ? `It is getting bitter between you and ${oppName}.` : `${oppName} is your nemesis now.` });
  }
  if (grudge) {
    (career.grudgeLog ||= []).push({ season: career.seasonIndex, oppId: nf.oppId, asked: career.grudge?.asked ?? null, won, method: result.method });
    career.grudge = null;
  }
  // Beat a rival and it may call you out.
  if (won) maybeCallOut(reg, career, nf.oppId, fixtureId, (id) => reg.robot(id).name);

  // The damage stays on the robot: the pit is where it gets fixed (Stage 7).
  // A multibot reports both units: [main, partner].
  if (condition) {
    const [mc, pcd] = Array.isArray(condition) ? condition : [condition, null];
    g.condition = pruneFresh(mc);
    if (g.partner && pcd) g.partnerCondition = pruneFresh(pcd);
  }
  if (oppCondition) afterFight(reg, career, nf.oppId, oppCondition, f);
  const repair = repairCost(reg, career, g.condition, g.partner ? g.partnerCondition : null);
  career.pit = { fixtureId, stage: f.stage, league: f.league, window: pitWindow(reg, f) };

  career.lastFight = {
    season: career.seasonIndex, fixtureId, oppId: nf.oppId, stage: f.stage, league: f.league, grudge,
    rivalry: { gain: meeting.gain, levelUp: meeting.levelUp, level: levelOf(reg, meeting.entry).level },
    result, won, earned: career.cash - before, repair, net: career.cash - before,
    lines: career.ledger.slice(ledgerStart),
  };
  checkSponsors(reg, career);
  return career.lastFight;
}

/** Simulate the player's fight with the resolver (the "let the AI fight it" button). */
export function simulatePlayerFight(reg, career) {
  const nf = nextFight(reg, career);
  if (!nf) return null;
  const f = nf.fixture;
  // The opponent as it set itself up for you (nextFight), at the difficulty.
  const defs = { [career.playerId]: fieldedDef(reg, career, career.playerId), [nf.oppId]: nf.opp };
  const r = resolveFight(reg, defs[f.a], defs[f.b], {
    seed: nf.seed, conditionA: wearOf(reg, career, f.a), conditionB: wearOf(reg, career, f.b),
  });
  const result = compactResult(r, { [f.a]: r.sides[f.a].damageScore, [f.b]: r.sides[f.b].damageScore }, "sim");
  const mine = r.sides[career.playerId].condition;
  return applyPlayerResult(reg, career, f.id, result, mine, r.sides[nf.oppId].condition);
}

/** What it would cost to put this damage right in full, after any parts discount (an estimate: the pit decides). */
export function repairCost(reg, career, condition, partnerCondition = null) {
  if (!condition && !partnerCondition) return { total: 0, lines: [] };
  const def = playerDef(reg, career);
  const a = assembleRobot(reg, def);
  Object.assign(a.condition, condition || {});
  const lines = conditionReport(a, reg.rules).filter((r) => r.repairCost > 0)
    .map((r) => ({ key: r.key, name: r.name, condition: r.condition, cost: r.repairCost }));
  if (def.partner && partnerCondition) {
    const p = assemblePartner(reg, def);
    Object.assign(p.condition, partnerCondition);
    for (const r of conditionReport(p, reg.rules).filter((x) => x.repairCost > 0)) lines.push({ key: `p.${r.key}`, name: `${def.partner.name}: ${r.name}`, condition: r.condition, cost: r.repairCost });
  }
  const discount = partsDiscount(reg, career);
  const gross = repairBill(lines.map((l) => ({ repairCost: l.cost }))) * (reg.economy.repairs?.labourMultiplier ?? 1);
  return { lines, gross: Math.round(gross), discount, total: Math.round(gross * (1 - discount)) };
}

/** The best parts discount the player has right now (sponsors and Giant Nut deals). */
export function partsDiscount(reg, career) {
  return discountOf(reg, career);
}

/**
 * Does the player meet a league sponsor's terms? Terms are per season - wins
 * and KOs this season, and the league the player is in - so a sponsor can be
 * won and lost again.
 */
function meetsTerms(reg, career, sp, league = playerLeague(career)) {
  const order = reg.league.leagues;
  const q = sp.requires || {};
  const rec = recordOf(career.season, career.playerId);
  return (q.wins == null || rec.wins >= q.wins) &&
    (q.kos == null || rec.kos >= q.kos) &&
    (q.league == null || order.indexOf(league) >= order.indexOf(q.league));
}

/** Sign any league sponsor whose terms the player now meets. */
function checkSponsors(reg, career) {
  if (career.season.kind !== "league") return;
  for (const sp of reg.economy.sponsors) {
    if (sp.kind !== "league" || career.sponsors.includes(sp.id)) continue;
    if (meetsTerms(reg, career, sp)) {
      career.sponsors.push(sp.id);
      career.notices.push({ kind: "sponsor", text: `${sp.name} signs on: $${sp.retainer.toLocaleString()} a season${sp.perWin ? `, $${sp.perWin.toLocaleString()} a win` : ""}.` });
    }
  }
}

/** At the end of a league season, sponsors whose terms were not met walk. */
function reviewSponsors(reg, career, nextLeague) {
  career.sponsors = career.sponsors.filter((id) => {
    const sp = sponsor(reg, id);
    if (!sp) return false;
    // A sponsor signed for reaching a league stays while you are in it; one
    // signed for results wants them again this season.
    const keep = meetsTerms(reg, career, sp, nextLeague);
    if (!keep) career.notices.push({ kind: "relegation", text: `${sp.name} did not renew your sponsorship.` });
    return keep;
  });
}

/** Close a finished season: prize money, trophies, movement, history. */
export function closeSeason(reg, career) {
  const s = career.season;
  const me = career.playerId;
  const econ = reg.economy;
  const fin = robotFinish(s, me);
  const entry = { season: s.index, kind: s.kind, cashBefore: null };

  if (s.kind === "league") {
    const lg = playerLeague(career);
    const l = s.leagues[lg];
    const pos = l.ranking.indexOf(me) + 1;
    const purse = econ.league[lg];
    if (fin.stage === "final") pay(career, purse.finals[Math.min(fin.finish, purse.finals.length - 1)], fin.finish >= fin.rounds ? "League champion!" : "Finals prize money");
    const up = l.movement.promoted.includes(me), down = l.movement.relegated.includes(me);
    if (up) pay(career, purse.promotionBonus, "Promotion bonus");
    if (l.champion === me) {
      career.trophies.push({ season: s.index, league: lg, title: `${leagueName(lg)} Champion`, robot: garageOf(reg, career).name });
      garageOf(reg, career).record && garageOf(reg, career).record.titles++;
    }
    const champions = Object.fromEntries(Object.entries(s.leagues).map(([k, v]) => [k, v.champion]));
    Object.assign(entry, { league: lg, position: pos, finish: fin, promoted: up, relegated: down, champions, record: recordOf(s, me) });
    checkSponsors(reg, career);
    reviewSponsors(reg, career, nextMembership(s, career.membership, reg.league)[me]);
    career.membership = nextMembership(s, career.membership, reg.league);
    entry.nextLeague = playerLeague(career);
    if (up) career.notices.push({ kind: "promotion", text: `Promoted to the ${leagueName(entry.nextLeague)} league!` });
    if (down) career.notices.push({ kind: "relegation", text: `Relegated to the ${leagueName(entry.nextLeague)} league.` });
  } else {
    const gn = s.giantNut;
    const g = econ.giantNut;
    const idx = fin.stage === "final" ? fin.finish + 1 : 0;
    if (gn.champion === me) pay(career, g.champion, "GIANT NUT CHAMPION!");
    else pay(career, g.rounds[Math.min(idx, g.rounds.length - 1)], fin.stage === "final" ? "Giant Nut bracket prize" : "Giant Nut participation");
    // Giant Nut sponsors: deals for how far the player got.
    const reached = fin.stage === "final" ? fin.finish + 1 : 0;
    for (const sp of econ.sponsors.filter((x) => x.kind === "giantNut")) {
      if (reached >= (sp.requires?.giantNutRound ?? 99)) {
        pay(career, sp.bonus, `${sp.name} Giant Nut deal`);
        if (sp.partsDiscount) career.perks.push({ id: sp.id, partsDiscount: sp.partsDiscount, until: s.index + 1 });
        if (sp.unlock && !career.unlocks.includes(sp.unlock)) career.unlocks.push(sp.unlock);
        career.notices.push({ kind: "sponsor", text: `${sp.name}: ${sp.blurb}` });
      }
    }
    const rec = { season: s.index, champion: gn.champion, finish: fin, record: recordOf(s, me), position: gn.ranking.indexOf(me) + 1 };
    career.giantNutHistory.push(rec);
    Object.assign(entry, rec);
  }
  career.history.push(entry);
  if (career.notices.length > 20) career.notices.splice(0, career.notices.length - 20);
}

/** The player's record in a season: { wins, losses, kos }. */
export function recordOf(season, id) {
  const fights = [...season.fixtures, ...(season.finalsLog || [])].filter((f) => f.result && (f.a === id || f.b === id));
  const wins = fights.filter((f) => f.result.winnerId === id);
  return { wins: wins.length, losses: fights.length - wins.length, kos: wins.filter((f) => f.result.method === "ko" || f.result.method === "tapout").length };
}

/** The player's group table this season. */
export function playerGroup(career) {
  const s = career.season;
  const me = career.playerId;
  const comp = s.kind === "league" ? playerLeague(career) : "giantNut";
  const groups = s.kind === "league" ? s.leagues[comp].groups : s.giantNut.groups;
  const g = groups.find((x) => x.ids.includes(me));
  return g ? { comp, name: g.name, rows: groupTables(s)[comp][g.name] } : null;
}

export const LEAGUE_TITLES = { rookie: "Rookie", pro: "Pro", elite: "Elite", world: "World Championship" };
const leagueName = (lg) => LEAGUE_TITLES[lg] || lg;

// ---------------------------------------------------------------- the pit (Stage 7)

/** The pit crew: base size from economy.json, plus whoever the player has hired. */
export function crewConfig(reg) {
  return { base: 2, max: 6, hireFee: [2500, 4000, 6500, 9500], salaryPerSeason: 1800, ...(reg.economy?.crew || {}) };
}
export const crewSize = (reg, career) => career.crew?.size ?? crewConfig(reg).base;

/** Hire one more crew member: a signing fee now, a salary every season. */
export function hireCrew(reg, career) {
  const cfg = crewConfig(reg);
  const n = crewSize(reg, career);
  if (n >= cfg.max) return { ok: false, reason: "The pit is full - that is the biggest crew allowed." };
  const fee = cfg.hireFee[Math.min(cfg.hireFee.length - 1, n - cfg.base)];
  if (career.cash < fee) return { ok: false, reason: `Signing a crew member costs $${fee.toLocaleString()}.` };
  pay(career, -fee, "Signed a pit crew member");
  career.crew = { ...(career.crew || {}), size: n + 1 };
  return { ok: true, fee };
}
/** Let one crew member go (no refund; it saves the salary). */
export function releaseCrew(reg, career) {
  const n = crewSize(reg, career);
  if (n <= crewConfig(reg).base) return { ok: false };
  career.crew = { ...(career.crew || {}), size: n - 1 };
  return { ok: true };
}

/** Pricing for the player's pit: their spares, the shop's prices, their discount. */
function pitCtx(reg, career) {
  return { spares: spares(reg, career), price: (id) => priceOf(reg, career, id), discount: discountOf(reg, career) };
}

/**
 * The pit as it stands: the robot's damage and every way of fixing it, the
 * window (minutes until the next fight) and the crew-minutes it gives.
 */
export function pitState(reg, career) {
  const units = playerUnits(reg, career);
  const window = career.pit?.window ?? pitWindow(reg, null);
  const crew = crewSize(reg, career);
  const ctx = pitCtx(reg, career);
  // A multibot's second unit's parts are keyed "p.<fitting>".
  const report = units.flatMap((u) => pitReport(reg, u.a, ctx).map((r) => ({ ...r, key: u.prefix + r.key, unit: u.prefix ? u.name : null })));
  return { open: !!career.pit, window, crew, crewMinutes: window * crew, assembled: units[0].a, units, report };
}

/** The player's units with their damage: [{ prefix, a, name }] (one, or two for a multibot). */
function playerUnits(reg, career) {
  const g = garageOf(reg, career);
  const def = playerDef(reg, career);
  const main = assembleRobot(reg, def);
  Object.assign(main.condition, g.condition || {});
  const units = [{ prefix: "", a: main, name: g.name }];
  if (def.partner) {
    const p = assemblePartner(reg, def);
    Object.assign(p.condition, g.partnerCondition || {});
    units.push({ prefix: "p.", a: p, name: def.partner.name });
  }
  return units;
}

/** Plan totals across both units, the spares shared between them. */
function unitTotals(reg, career, plan) {
  const units = playerUnits(reg, career);
  const ctx = pitCtx(reg, career);
  let spares = { ...ctx.spares };
  const out = { cost: 0, salvage: 0, minutes: 0, condition: {}, partnerCondition: {}, replaced: [], sparesUsed: {}, bought: {}, lines: [] };
  for (const u of units) {
    const sub = {};
    for (const [k, v] of Object.entries(plan)) {
      if (u.prefix ? k.startsWith(u.prefix) : !k.startsWith("p.")) sub[u.prefix ? k.slice(u.prefix.length) : k] = v;
    }
    const t = planTotals(reg, u.a, sub, { ...ctx, spares });
    for (const k of ["cost", "salvage", "minutes"]) out[k] += t[k];
    if (u.prefix) out.partnerCondition = t.condition; else out.condition = t.condition;
    out.replaced.push(...t.replaced);
    for (const [id, n] of Object.entries(t.sparesUsed)) { out.sparesUsed[id] = (out.sparesUsed[id] || 0) + n; spares[id] = (spares[id] || 0) - n; }
    for (const [id, n] of Object.entries(t.bought)) out.bought[id] = (out.bought[id] || 0) + n;
    out.lines.push(...t.lines.map((l) => ({ ...l, key: u.prefix + l.key, name: u.prefix ? `${u.name}: ${l.name}` : l.name })));
  }
  out.net = out.cost - out.salvage;
  return out;
}

/** What a plan ({ fittingKey: "patch" | "repair" | "replace" }) would come to, and whether it is allowed. */
export function pitQuote(reg, career, plan) {
  const st = pitState(reg, career);
  const t = unitTotals(reg, career, plan);
  const problems = [];
  if (t.minutes > st.crewMinutes) problems.push(`That is ${t.minutes} crew-minutes of work; your crew of ${st.crew} has ${st.crewMinutes} before the next fight.`);
  if (t.cost > career.cash) problems.push(`That costs $${t.cost.toLocaleString()}; you have $${Math.round(career.cash).toLocaleString()}.`);
  return { ...t, crewMinutes: st.crewMinutes, problems, ok: problems.length === 0 };
}

/** The crew's own best plan for the time and money there is. */
export function pitAutoPlan(reg, career) {
  const st = pitState(reg, career);
  const ctx = pitCtx(reg, career);
  // The main unit first, then the second with whatever time and money is left.
  const plan = {};
  let minutes = st.crewMinutes, cash = Math.max(0, career.cash);
  for (const u of st.units) {
    const p = autoPlan(reg, u.a, { crewMinutes: minutes, cash, ctx });
    const t = planTotals(reg, u.a, p, ctx);
    minutes -= t.minutes; cash -= t.cost;
    for (const [k, v] of Object.entries(p)) plan[u.prefix + k] = v;
  }
  return plan;
}

/**
 * Do the work and send the robot out: pay for it, take the salvage, swap in
 * spares or new parts, and close the pit. Anything not in the plan stays
 * broken for the next fight.
 */
export function doPit(reg, career, plan) {
  const q = pitQuote(reg, career, plan);
  if (!q.ok) return { ok: false, errors: q.problems };
  const g = garageOf(reg, career);
  const repairs = q.lines.filter((l) => l.how !== "replace").reduce((t, l) => t + l.cost, 0);
  if (repairs) pay(career, -repairs, `Pit: ${q.lines.filter((l) => l.how !== "replace").length} repair${q.lines.length > 1 ? "s" : ""}`);
  for (const [id, n] of Object.entries(q.bought)) pay(career, -priceOf(reg, career, id) * n, `Pit: new ${reg.part(id).name}${n > 1 ? ` x${n}` : ""}`);
  // A replacement uses a spare if there is one; either way the old part is scrapped.
  for (const [id, n] of Object.entries(q.sparesUsed)) g.owned[id] = Math.max(0, (g.owned[id] || 0) - n);
  if (q.salvage) pay(career, q.salvage, "Pit: scrap salvage");
  g.condition = pruneFresh(q.condition);
  if (g.partner) g.partnerCondition = pruneFresh(q.partnerCondition);
  career.pit = null;
  return { ok: true, ...q };
}

/** Close the pit without doing anything (the damage goes into the next fight). */
export function skipPit(career) { career.pit = null; }

/**
 * Between seasons everyone rebuilds: AI robots come back fresh, and the
 * player's damage is put right at the off-season rate (no pit clock, no
 * overtime). Crew salaries are paid.
 */
function offseasonRebuild(reg, career) {
  const g = garageOf(reg, career);
  const est = repairCost(reg, career, g.condition, g.partner ? g.partnerCondition : null);
  const rate = pitConfig(reg).offseasonRepairRate;
  if (est.total > 0) pay(career, -Math.round(est.total * rate), "Off-season rebuild");
  g.condition = {};
  g.partnerCondition = {};
  career.wear = {};
  career.pit = null;
  const extra = crewSize(reg, career) - crewConfig(reg).base;
  if (extra > 0) pay(career, -extra * crewConfig(reg).salaryPerSeason, `Pit crew salaries (${extra})`);
}

// ---------------------------------------------------------------- retirement (Stage 7)

/**
 * Retire the robot: its name, versions and record go to the garage's
 * museum, and a new robot (version 1.0, under `newName`) starts from the same
 * parts - rebuild it in the workshop.
 */
export function retireRobot(reg, career, newName) {
  const g = garageOf(reg, career);
  const rec = g.record || { fights: 0, wins: 0, kos: 0, titles: 0, since: career.seasonIndex };
  (g.museum ||= []).push({ name: g.name, version: g.version, from: rec.since, to: career.seasonIndex, ...rec,
    weapon: g.build.weapon ? reg.part(g.build.weapon).name : "None", livery: g.livery });
  g.name = String(newName || "").trim().slice(0, 28) || `${g.name} II`;
  g.version = "1.0";
  g.log = [];
  g.record = { fights: 0, wins: 0, kos: 0, titles: 0, since: career.seasonIndex };
  return g.museum[g.museum.length - 1];
}

// ---------------------------------------------------------------- the save file

/** The career as a save string. Versioned: load() migrates old saves. */
export function serialize(career) {
  return JSON.stringify(career);
}

/** A career from a save string, migrated to the current version. Throws on junk. */
export function deserialize(text) {
  const c = JSON.parse(text);
  if (!c || c.schema !== CAREER_SCHEMA) throw new Error("not a ROBO LEAGUE career save");
  if (c.version > CAREER_VERSION) throw new Error(`this save is from a newer version (${c.version})`);
  // Migrations, oldest first.
  // 2: the garage. It needs the registry to build, so garageOf() makes it on
  // first use; a version-1 save starts with the robot file's robot, owned.
  if (c.version < 2) { c.garage = null; c.version = 2; }
  // 3: damage carries over; from here on the career starts every robot fresh.
  if (c.version < 3) {
    c.wear = {}; c.crew = { size: null }; c.pit = null;
    Object.assign(c.stats, { streak: 0, bestStreak: 0, fastestKoS: null, mostDamage: 0, ...c.stats });
    c.version = 3;
  }
  // 4: the living field. Drivers are seeded on the next off-season (seedDrivers).
  if (c.version < 4) {
    c.drivers ||= {}; c.robotLife ||= {}; c.newcomers ||= {}; c.retired ||= []; c.ai ||= {};
    c.difficulty ||= "medium";
    c.version = 4;
  }
  // 5: rivalries. The history starts from here: older fights are not in the book.
  if (c.version < 5) {
    c.rivals ||= {}; c.grudge ??= null; c.challenge ??= null; c.grudgeLog ||= [];
    c.version = 5;
  }
  // 6: loans and trading. Nothing owed, nothing sold yet.
  if (c.version < 6) {
    c.loans ||= []; c.market = null; c.robotSales ||= []; c.tape ||= {};
    c.version = 6;
  }
  c.notices ||= [];
  c.evolution ||= {};
  c.perks ||= [];
  c.unlocks ||= [];
  return c;
}

/** A short, stable random draw for UI flavour that must not touch game seeds. */
export const flavourRng = (career, tag) => makeRng(hashSeed(`${career.seed}:flavour:${tag}`));
