// rivalry.js - robots with a history against you.
//
// Every robot the player has fought keeps a head-to-head record against
// them (career.rivals[id]), and every meeting adds HEAT: more for a
// knockout, a split decision, a playoff fight, a title fight, revenge, an
// upset or a grudge match. Heat cools between seasons. Enough of it and the
// two robots have a rivalry; more and it is bitter; the most of all and it
// is your nemesis.
//
// What a rivalry does:
//   - the scouting card (and the fight's commentary) tells the story so far
//     - storyline();
//   - a rival studies you harder before the fight and its driver is fired
//     up - rivalPrep();
//   - the promoters pay a gate bonus for it - rivalGate();
//   - GRUDGE MATCHES: after a fight you can demand a rematch (they may say
//     no), and a rival you have just beaten may call you out. A grudge match
//     is fought before your next fight, outside the standings, for its own
//     purse; the damage counts like any other fight.
//
// Pure logic over the career object; numbers in data/league.json `rivalry`.

import { makeRng, hashSeed } from "../core/rng.js";

const LEVEL_NAMES = ["", "Rivalry", "Bitter rivalry", "Nemesis"];

export function rivalryConfig(reg) {
  const r = reg.league?.rivalry || {};
  return {
    levels: [3, 6, 10],              // heat for rivalry, bitter, nemesis
    decay: 0.6,                      // heat kept from one season to the next
    heat: { meet: 1, ko: 1, split: 1, playoff: 1, titleFight: 2, revenge: 1, streak: 1, upset: 1, giantNut: 0.5, grudge: 1.5, ducked: 1, refused: 0.5 },
    upsetTiers: 1,                   // leagues apart that make the win an upset
    prepOptions: 1,                  // extra setups a rival tests against you, per level
    skillPerLevel: 0.02,             // its driver, fired up
    gatePerLevel: 0.25,              // gate bonus: this much of the appearance fee per level
    grudge: { appearanceX: 2, winX: 1.5, koX: 1, perLevel: 0.25, maxPerSeason: 2 },
    accept: { base: 0.3, theyLost: 0.4, perLevel: 0.12 },
    callOut: { base: 0.25, perLevel: 0.15 },
    moments: 8,
    ...r,
  };
}

// ---------------------------------------------------------------- the record

/** A robot's history against the player, or null if they have never met. */
export const rivalOf = (career, id) => career.rivals?.[id] || null;

/** How hot a rivalry is: { level 0..3, name }. Level 0 with fights is just history. */
export function levelOf(reg, entry) {
  if (!entry) return { level: 0, name: "" };
  const lv = rivalryConfig(reg).levels;
  const level = entry.heat >= lv[2] ? 3 : entry.heat >= lv[1] ? 2 : entry.heat >= lv[0] ? 1 : 0;
  return { level, name: LEVEL_NAMES[level] };
}

const blank = (career) => ({ fights: 0, w: 0, l: 0, koFor: 0, koAgainst: 0, grudges: 0, heat: 0, first: career.seasonIndex, last: null, streak: 0, moments: [], peak: 0 });

/**
 * One meeting between the player and `oppId`, from the player's side.
 * @param m { won, result, fixture, grudge, titleFight, myTier, oppTier, stageName, eliminated, driver }
 * @returns { gain, entry, levelUp } - levelUp is the new level's name if it rose
 */
export function recordMeeting(reg, career, oppId, m) {
  const cfg = rivalryConfig(reg);
  career.rivals ||= {};
  const e = (career.rivals[oppId] ||= blank(career));
  const before = levelOf(reg, e).level;
  const r = m.result || {};
  const ko = r.method === "ko" || r.method === "tapout";
  const h = cfg.heat;
  let gain = h.meet;
  const why = [];
  if (ko) { gain += h.ko; why.push(m.won ? "you knocked them out" : "they knocked you out"); }
  if (r.method === "decision" && r.decision === "split") { gain += h.split; why.push("a split decision"); }
  if (m.fixture?.stage === "final") { gain += h.playoff; if (m.titleFight) gain += h.titleFight; }
  if (m.fixture?.league === "giantNut") gain += h.giantNut;
  if (m.grudge) gain += h.grudge;
  // Revenge: the loser last time won this one.
  const revenge = e.last && e.last.won !== m.won;
  if (revenge) gain += h.revenge;
  // The same side winning again and again.
  const streak = e.last && e.last.won === m.won ? (e.streak || 1) + 1 : 1;
  if (streak >= 3) gain += h.streak;
  // An upset: a robot from a lower league beat one from a higher (the Giant
  // Nut's mixed groups, a grudge match across leagues). `tier` is the
  // league's place in the order, bottom 0.
  const gap = (m.oppTier ?? 0) - (m.myTier ?? 0);
  const upset = (m.won && gap >= cfg.upsetTiers) || (!m.won && -gap >= cfg.upsetTiers);
  if (upset) gain += h.upset;

  e.fights++;
  if (m.won) e.w++; else e.l++;
  if (ko && m.won) e.koFor++;
  if (ko && !m.won) e.koAgainst++;
  if (m.grudge) e.grudges++;
  e.heat = round1(e.heat + gain);
  e.peak = Math.max(e.peak || 0, e.heat);
  e.streak = streak;
  e.last = {
    season: career.seasonIndex, won: m.won, method: r.method ?? null, cause: r.cause ?? null, decision: r.decision ?? null,
    elapsedS: Math.round(r.elapsedS ?? 0), stage: m.fixture?.stage ?? null, league: m.fixture?.league ?? null,
    stageName: m.stageName || null, grudge: !!m.grudge, driver: m.driver || null, eliminated: !!m.eliminated,
  };
  // The memorable ones go in the book.
  const big = ko || m.fixture?.stage === "final" || m.grudge || upset || revenge || r.decision === "split";
  if (big) {
    const how = ko ? (m.won ? `you knocked them out${r.cause ? ` (${r.cause})` : ""}` : `they knocked you out${r.cause ? ` (${r.cause})` : ""}`)
      : `${m.won ? "you won" : "they won"} on ${r.decision === "split" ? "a split decision" : "the judges' decision"}`;
    const where = m.grudge ? "the grudge match" : m.stageName || (m.fixture?.stage === "final" ? "the playoffs" : "the group stage");
    addMoment(cfg, e, career, `${cap(how)} in ${where}${upset ? " - an upset" : revenge ? " - revenge" : ""}.`);
  }
  const after = levelOf(reg, e);
  return { gain, entry: e, levelUp: after.level > before ? after.name : null };
}

function addMoment(cfg, e, career, text) {
  e.moments.push({ season: career.seasonIndex, text });
  if (e.moments.length > cfg.moments) e.moments.splice(0, e.moments.length - cfg.moments);
}

/** Heat for something that happened off the floor (a refused rematch, a ducked call-out). */
export function addHeat(reg, career, oppId, kind, text = null) {
  const cfg = rivalryConfig(reg);
  career.rivals ||= {};
  const e = (career.rivals[oppId] ||= blank(career));
  const before = levelOf(reg, e).level;
  e.heat = round1(e.heat + (cfg.heat[kind] ?? 0));
  e.peak = Math.max(e.peak || 0, e.heat);
  if (text) addMoment(cfg, e, career, text);
  const after = levelOf(reg, e);
  return after.level > before ? after.name : null;
}

/** A new season: every rivalry cools off a little. */
export function coolRivalries(reg, career) {
  const k = rivalryConfig(reg).decay;
  for (const e of Object.values(career.rivals || {})) e.heat = round1(e.heat * k);
}

/**
 * The off-season moved the field on (field.js report): a robot replaced by
 * its team's new one hands the feud on, cooler; a robot whose team folded
 * leaves its record in the book, retired. A grudge match booked against a
 * robot that is gone is off.
 */
export function carryRivalries(reg, career, report, nameOf = (id) => id) {
  const rv = career.rivals || {};
  const out = [];
  for (const nr of report?.newRobots || []) {
    if (!nr.replacesId || !rv[nr.replacesId]) continue;
    const old = rv[nr.replacesId];
    if (old.retired) continue;
    if (levelOf(reg, old).level >= 1) {
      rv[nr.id] = { ...blank(career), heat: round1(old.heat * 0.5), carried: { fromId: nr.replacesId, from: nr.replaces, w: old.w, l: old.l } };
      addMoment(rivalryConfig(reg), rv[nr.id], career, `${nr.team} built it to replace ${nr.replaces} (${old.w}-${old.l} against you).`);
      out.push({ id: nr.id, name: nr.name, from: nr.replaces });
    }
    old.retired = career.seasonIndex;
  }
  for (const r of report?.retiredRobots || []) if (rv[r.id] && !rv[r.id].retired) rv[r.id].retired = career.seasonIndex;
  if (career.grudge && !(career.grudge.oppId in career.membership)) {
    career.notices.push({ kind: "relegation", text: `The grudge match with ${nameOf(career.grudge.oppId)} is off: it has retired.` });
    career.grudge = null;
  }
  if (career.challenge && !(career.challenge.oppId in career.membership)) career.challenge = null;
  return out;
}

/** Every robot with a history against the player, the hottest first. */
export function rivalsList(reg, career, { active = true } = {}) {
  return Object.entries(career.rivals || {})
    .filter(([id, e]) => e.fights > 0 || e.carried)
    .filter(([id, e]) => !active || (!e.retired && id in career.membership))
    .map(([id, e]) => ({ id, ...e, ...levelOf(reg, e) }))
    .sort((a, b) => b.heat - a.heat || b.fights - a.fights);
}

/** The player's nemesis over the whole career (for the Hall of Fame): most heat ever, then most fights. */
export function nemesisOf(reg, career) {
  const all = Object.entries(career.rivals || {}).filter(([, e]) => e.fights >= 2);
  all.sort((a, b) => (b[1].peak || b[1].heat) - (a[1].peak || a[1].heat) || b[1].fights - a[1].fights);
  return all.length ? { id: all[0][0], ...all[0][1] } : null;
}

// ---------------------------------------------------------------- the story

/**
 * The story so far, as a few short lines for the scouting card and the
 * commentary. `names.me` and `names.them` are the robots' names.
 */
export function storyline(reg, career, oppId, { names = {}, driver = null, grudge = null } = {}) {
  const e = rivalOf(career, oppId);
  const them = names.them || "They";
  const out = [];
  if (grudge) out.push(grudge.asked === "them" ? `${them} called you out. This one is personal.` : "You asked for this one.");
  if (!e) return out;
  if (e.carried && !e.fights) {
    out.push(`${them} is the robot that replaced ${e.carried.from}, which went ${e.carried.l}-${e.carried.w} against you. Same team, same grudge.`);
    return out;
  }
  if (!e.fights) return out;
  const n = e.fights + 1;
  const series = e.w === e.l ? `The series is level at ${e.w}-${e.l}.`
    : e.w > e.l ? `You lead the series ${e.w}-${e.l}${e.l === 0 ? ` - ${them} has never beaten you` : ""}.`
      : `${them} leads the series ${e.l}-${e.w}${e.w === 0 ? " - you have never beaten it" : ""}.`;
  out.push(`${n === 2 ? "The rematch" : `Meeting number ${n}`}. ${series}`);
  const L = e.last;
  if (L) {
    const when = L.season === career.seasonIndex ? "earlier this season" : L.season === career.seasonIndex - 1 ? "last season" : `in season ${L.season}`;
    const how = L.method === "ko" || L.method === "tapout"
      ? (L.won ? `you knocked it out${L.cause ? ` (${L.cause})` : ""}` : `it knocked you out${L.cause ? ` (${L.cause})` : ""}`)
      : `${L.won ? "you" : "it"} won on ${L.decision === "split" ? "a split" : "the judges'"} decision`;
    const where = L.grudge ? " in a grudge match" : L.stageName ? ` in the ${L.stageName}` : "";
    out.push(`Last time, ${when}: ${how}${where}${L.eliminated && !L.won ? " - and that put you out" : L.eliminated && L.won ? " - and that put it out" : ""}.`);
    if (!L.won) out.push("Revenge is on the table.");
    else if (L.method === "decision" && L.decision === "split") out.push(`${them} thinks it won that one.`);
  }
  if (e.koAgainst >= 2) out.push(`It has knocked you out ${e.koAgainst} times.`);
  else if (e.koFor >= 2) out.push(`You have knocked it out ${e.koFor} times.`);
  if (e.streak >= 3) out.push(L?.won ? `You have won the last ${e.streak}.` : `It has won the last ${e.streak}.`);
  if (driver && L?.driver && driver !== L.driver) out.push(`A new driver since then: ${driver} has taken over from ${L.driver}.`);
  const lv = levelOf(reg, e);
  if (lv.level >= 1) out.push(lv.level === 3 ? "Your nemesis. The crowd knows it." : lv.level === 2 ? "There is real bad blood here." : "The fans are calling it a rivalry.");
  return out;
}

// ---------------------------------------------------------------- what it does

/** How much harder a rival works on you: extra setups to test and a fired-up driver. */
export function rivalPrep(reg, career, oppId, { testing = true } = {}) {
  const cfg = rivalryConfig(reg);
  const { level } = levelOf(reg, rivalOf(career, oppId));
  const grudge = career.grudge?.oppId === oppId ? 1 : 0;
  return { level, extraOptions: testing ? (level + grudge) * cfg.prepOptions : 0, skill: round3((level + grudge) * cfg.skillPerLevel) };
}

/** The gate bonus the promoters pay for a rivalry fight (a share of the appearance fee per level). */
export function rivalGate(reg, career, oppId, appearance) {
  const { level } = levelOf(reg, rivalOf(career, oppId));
  return level ? Math.round(appearance * level * rivalryConfig(reg).gatePerLevel) : 0;
}

// ---------------------------------------------------------------- grudge matches

/** A grudge match purse: the league's purses scaled up, more for a hotter rivalry. */
export function grudgePurse(reg, career, oppId, base) {
  const g = rivalryConfig(reg).grudge;
  const { level } = levelOf(reg, rivalOf(career, oppId));
  const k = 1 + level * g.perLevel;
  return {
    appearance: Math.round(base.appearance * g.appearanceX * k),
    win: Math.round(base.win * g.winX * k),
    koBonus: Math.round(base.koBonus * g.koX * k),
  };
}

const grudgesThisSeason = (career) => (career.grudgeLog || []).filter((x) => x.season === career.seasonIndex).length + (career.grudge?.season === career.seasonIndex ? 1 : 0);

/**
 * Can the player demand a rematch with the robot they just fought? Not if one
 * is already booked or asked for, not if that robot is gone, and only so many
 * a season.
 */
export function canAskRematch(reg, career) {
  const lf = career.lastFight;
  if (!lf || career.grudge || career.challenge) return { ok: false };
  if (lf.rematch) return { ok: false, reason: lf.rematch.accepted ? "Booked." : "They said no." };
  if (!(lf.oppId in career.membership)) return { ok: false };
  if (grudgesThisSeason(career) >= rivalryConfig(reg).grudge.maxPerSeason) return { ok: false, reason: `No more than ${rivalryConfig(reg).grudge.maxPerSeason} grudge matches a season.` };
  return { ok: true };
}

/**
 * Demand a rematch. The other team says yes or no - more likely yes if they
 * lost (they want revenge) or the rivalry runs hot, less if they have
 * nothing to prove. Settled by the seed: asking again changes nothing.
 * @returns { accepted, text }
 */
export function askRematch(reg, career, { nameOf = (id) => id, personality = "" } = {}) {
  const can = canAskRematch(reg, career);
  if (!can.ok) return { accepted: false, text: can.reason || "Not now." };
  const lf = career.lastFight;
  const cfg = rivalryConfig(reg).accept;
  const { level } = levelOf(reg, rivalOf(career, lf.oppId));
  const p = cfg.base + (lf.won ? cfg.theyLost : 0) + level * cfg.perLevel + (personality === "aggressive" ? 0.1 : personality === "defensive" ? -0.1 : 0);
  const rng = makeRng(hashSeed(`${career.seed}:rematch:${lf.fixtureId}`));
  const accepted = rng.next() < p;
  const them = nameOf(lf.oppId);
  if (accepted) {
    book(career, lf.oppId, "you");
    lf.rematch = { accepted: true };
    const text = lf.won ? `${them} wants revenge: grudge match booked before your next fight.` : `${them} accepts: grudge match booked before your next fight.`;
    career.notices.push({ kind: "rivalry", text });
    return { accepted, text };
  }
  lf.rematch = { accepted: false };
  const levelUp = addHeat(reg, career, lf.oppId, "refused", `${them} turned down your rematch.`);
  const text = lf.won ? `${them} turned you down. They are not ready to see you again.` : `${them} turned you down: "We already beat you."`;
  career.notices.push({ kind: "rivalry", text: text + (levelUp ? ` ${levelUp}!` : "") });
  return { accepted, text };
}

/**
 * After the player beats a rival, that rival may call them out. Settled by
 * the seed. Leaves career.challenge for the hub to answer.
 */
export function maybeCallOut(reg, career, oppId, fixtureId, nameOf = (id) => id) {
  if (career.grudge || career.challenge) return null;
  if (!(oppId in career.membership)) return null;
  const { level } = levelOf(reg, rivalOf(career, oppId));
  if (!level) return null;
  if (grudgesThisSeason(career) >= rivalryConfig(reg).grudge.maxPerSeason) return null;
  const cfg = rivalryConfig(reg).callOut;
  const rng = makeRng(hashSeed(`${career.seed}:callout:${fixtureId}`));
  if (rng.next() >= cfg.base + level * cfg.perLevel) return null;
  const lines = [
    `${nameOf(oppId)} wants you back in the box. "That was a fluke."`,
    `${nameOf(oppId)}'s team is calling you out: a grudge match, before your next fight.`,
    `${nameOf(oppId)} demands a rematch. "Any time, any arena."`,
  ];
  career.challenge = { oppId, fixtureId, season: career.seasonIndex, text: lines[Math.floor(rng.next() * lines.length)] };
  return career.challenge;
}

/** Answer a call-out: accept books the grudge match; ducking it costs you nothing but face (and adds heat). */
export function answerChallenge(reg, career, accept, nameOf = (id) => id) {
  const c = career.challenge;
  if (!c) return null;
  career.challenge = null;
  if (accept) {
    book(career, c.oppId, "them");
    career.notices.push({ kind: "rivalry", text: `Grudge match on: you against ${nameOf(c.oppId)}, before your next fight.` });
    return { accepted: true };
  }
  const levelUp = addHeat(reg, career, c.oppId, "ducked", `You turned down ${nameOf(c.oppId)}'s call-out.`);
  career.notices.push({ kind: "rivalry", text: `You turned ${nameOf(c.oppId)} down. Their fans say you ducked them.${levelUp ? ` ${levelUp}!` : ""}` });
  return { accepted: false };
}

/** Call off a booked grudge match (it counts as ducking it). */
export function cancelGrudge(reg, career, nameOf = (id) => id) {
  const g = career.grudge;
  if (!g) return null;
  career.grudge = null;
  addHeat(reg, career, g.oppId, "ducked", `You called off the grudge match with ${nameOf(g.oppId)}.`);
  return g;
}

function book(career, oppId, asked) {
  const n = (career.grudgeLog || []).length + 1;
  career.grudge = { id: `g${career.seasonIndex}:${n}:${oppId}`, oppId, season: career.seasonIndex, asked };
}

/** The booked grudge match as a fixture the fight screens understand. */
export function grudgeFixture(career, leagueOf) {
  const g = career.grudge;
  if (!g) return null;
  return { id: g.id, stage: "grudge", league: leagueOf(g.oppId), a: career.playerId, b: g.oppId, grudge: true, asked: g.asked, result: null };
}

const round1 = (x) => Math.round(x * 10) / 10;
const round3 = (x) => Math.round(x * 1000) / 1000;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
