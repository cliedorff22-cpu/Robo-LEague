// evolution.js - the off-season: every AI team works on its robot, as teams
// do between seasons on the show.
//
// Pure logic over the career save. For each robot in the field (never the
// player's - that is the workshop's job):
//
//   - the DRIVER gets better with fights fought and fights won, and can slip
//     after a bad season (its rating moves);
//   - the TEAM has a budget - money from its league and its results, plus
//     whatever it saved - and buys upgrades from the real parts catalog: a
//     bigger weapon motor, a heavier rotor, better armour, more drive. Every
//     candidate must stay legal (250 lb, rule checks) and is TESTED: fought
//     against robots from its league with the fast resolver, the same seeds
//     before and after, and only bought if it actually wins more;
//   - a robot stuck at the bottom for two seasons may be REDESIGNED around a
//     different weapon its body can carry - a new version, as teams do.
//
// The robot keeps its identity: chassis, body and paint never change. What
// changed is kept in `career.evolution[id]` and merged over the robot file by
// fieldedDef() - the robot files are never touched. All tunables are in
// data/league.json `evolution`.

import { makeRng, hashSeed } from "../core/rng.js";
import { assembleRobot, assemblePartner } from "./build.js";
import { resolveFight } from "./resolver.js";
import { familyOf } from "./weapon.js";
import { learnedUpgrades } from "./ailearn.js";
import { difficultyOf } from "./settings.js";

const DEFAULTS = {
  budget: { rookie: 2500, pro: 4000, elite: 6500, world: 10000 },
  perWin: 600,
  resale: 0.4,             // an old part fetches this share of its price
  maxUpgrades: 2,          // per off-season
  candidates: 5,           // upgrades tested per robot
  evalOpponents: 6,        // how many league robots a candidate is tested against
  minGain: 0.05,           // the win rate a part has to add to be worth buying
  rating: { talent: 12, learn: 0.3, perWinShare: 8, noise: 2, min: 5, max: 99 },
  redesign: { worstSeasons: 2, belowWinShare: 0.3, chance: 0.2, minGain: 0.15, everySeasons: 6 },
  bankSeasons: 4,          // a team saves at most this many seasons' budget
};

export function evolutionConfig(reg) {
  const e = reg.league?.evolution || {};
  return { ...DEFAULTS, ...e, budget: { ...DEFAULTS.budget, ...(e.budget || {}) },
    rating: { ...DEFAULTS.rating, ...(e.rating || {}) }, redesign: { ...DEFAULTS.redesign, ...(e.redesign || {}) } };
}

/**
 * The robot's version: the major number goes up with a redesign, the minor
 * with every off-season it was upgraded. "2.1" = rebuilt once, upgraded since.
 */
export const versionOf = (career, id) => {
  const e = career.evolution?.[id];
  return e ? `${e.version || 1}.${e.revision || 0}` : "1.0";
};

/** A robot def with its off-season changes applied. */
export function evolvedDef(reg, career, id) {
  const base = reg.robot(id);
  const e = career.evolution?.[id];
  if (!e) return base;
  return { ...base, build: e.build ?? base.build, rating: e.rating ?? base.rating,
    archetype: e.archetype ?? base.archetype, version: e.version };
}

/**
 * Run the off-season after `season`. Mutates career.evolution.
 * @param fielded(id) -> the def a robot fights as (league applied)
 * @returns { moves: [{ id, version, notes: [text] }] } the off-season report
 */
export function evolveField(reg, career, season, fielded) {
  const cfg = evolutionConfig(reg);
  const rng = makeRng(hashSeed(`${career.seed}:evolve:${season.index}`));
  career.evolution ||= {};
  const moves = [];
  const leagueOf = (id) => career.membership[id];
  // The field as it stands - robots retire and new ones join (field.js).
  const field = Object.keys(career.membership).filter((id) => id !== career.playerId);
  const byLeague = {};
  for (const id of field) (byLeague[leagueOf(id)] ||= []).push(id);

  for (const id of field) {
    const e = (career.evolution[id] ||= { version: 1, bank: 0, history: [] });
    const rec = recordIn(season, id);
    const notes = [];

    // ---- the driver: learns toward their own ceiling (a little above where
    // they started - not everyone becomes a world-class driver), and a good
    // or bad season moves them about it.
    const def0 = fielded(id);
    const share = rec.fights ? rec.wins / rec.fights : 0.5;
    const r0 = def0.rating;
    // Toward the driver's own potential (field.js), or the robot file's rating plus talent.
    const ceiling = Math.min(cfg.rating.max, career.drivers?.[id]?.potential ?? reg.robot(id).rating + cfg.rating.talent);
    const delta = (ceiling - r0) * cfg.rating.learn + (share - 0.5) * cfg.rating.perWinShare + rng.float(-cfg.rating.noise, cfg.rating.noise);
    e.rating = Math.round(Math.max(cfg.rating.min, Math.min(cfg.rating.max, r0 + delta)));
    if (Math.abs(e.rating - r0) >= 4) notes.push(`driver ${e.rating > r0 ? "improved" : "slipped"}: rated ${r0} -> ${e.rating}`);

    // ---- the money
    // The difficulty setting scales what the AI teams can spend.
    const budget = (cfg.budget[leagueOf(id)] ?? cfg.budget.rookie) * (difficultyOf(reg, career.difficulty || "medium").aiBudget ?? 1);
    e.bank = Math.min(budget * cfg.bankSeasons, (e.bank || 0) + budget + rec.wins * cfg.perWin);
    e.history = [...(e.history || []), share].slice(-4);

    // ---- the build
    const opponents = rng.shuffle((byLeague[leagueOf(id)] || []).filter((x) => x !== id)).slice(0, cfg.evalOpponents);
    const evalSeeds = opponents.map((_, k) => hashSeed(`${career.seed}:eval:${season.index}:${id}:${k}`));
    const test = (def) => winShare(reg, { ...def, league: leagueOf(id) }, opponents.map((o) => fielded(o)), evalSeeds);

    let def = { ...fielded(id), rating: e.rating };
    // A redesign: two bad seasons running, and the team decides to start over
    // around a different weapon its body can carry.
    const slumped = e.history.length >= cfg.redesign.worstSeasons &&
      e.history.slice(-cfg.redesign.worstSeasons).every((x) => x < cfg.redesign.belowWinShare);
    const canRedesign = season.index - (e.redesignedAt ?? -99) >= cfg.redesign.everySeasons;
    if (slumped && canRedesign && rng.bool(cfg.redesign.chance)) {
      const re = redesign(reg, def, rng, test, cfg.redesign.minGain);
      if (re) {
        def = re.def;
        e.version = (e.version || 1) + 1;
        e.revision = 0;
        e.archetype = re.def.archetype;
        e.redesignedAt = season.index;
        e.history = [];
        notes.push(`rebuilt as ${re.label}`);
      }
    }

    let base = test(def);
    for (let n = 0; n < cfg.maxUpgrades; n++) {
      // What has been beating it this season comes first (ailearn.js), then
      // the catalog's step-ups - all of them tested the same way.
      const learned = learnedUpgrades(reg, career, { ...def, id, league: leagueOf(id) })
        .filter((c) => c.cost <= e.bank && legal(reg, { ...def, build: c.build }))
        .map((c) => ({ def: { ...def, build: c.build }, cost: c.cost, note: c.note }));
      const cands = [...learned, ...upgradeCandidates(reg, def, e.bank, cfg)].slice(0, cfg.candidates + learned.length);
      let best = null;
      for (const c of cands) {
        const w = test(c.def);
        if (w >= base + cfg.minGain && (!best || w - c.cost / 20000 > best.w - best.cost / 20000)) best = { ...c, w };
      }
      if (!best) break;
      def = best.def;
      e.bank -= best.cost;
      notes.push(best.note);
      base = best.w;
    }
    if (def.build !== fielded(id).build) {
      e.build = def.build;
      if (!notes.some((x) => x.startsWith("rebuilt"))) e.revision = (e.revision || 0) + 1;
    }
    if (notes.length) {
      moves.push({ id, version: versionOf(career, id), notes });
      e.log = [...(e.log || []), { season: season.index, notes }].slice(-6);
    }
  }
  return { season: season.index, moves };
}

/** Wins/fights for a robot in a season (group and finals). */
function recordIn(season, id) {
  const fights = [...season.fixtures, ...(season.finalsLog || [])].filter((f) => f.result && (f.a === id || f.b === id));
  return { fights: fights.length, wins: fights.filter((f) => f.result.winnerId === id).length };
}

/** Share of fights won against these opponents, with fixed seeds. */
function winShare(reg, def, opponents, seeds) {
  let w = 0;
  opponents.forEach((o, k) => {
    // Both corners, so a candidate is not judged on corner luck.
    if (resolveFight(reg, def, o, { seed: seeds[k] }).winnerId === def.id) w++;
    if (resolveFight(reg, o, def, { seed: seeds[k] ^ 0x5bd1 }).winnerId === def.id) w++;
  });
  return opponents.length ? w / (opponents.length * 2) : 0.5;
}

/** A build is legal (and a multibot still makes weight with its partner). */
function legal(reg, def) {
  try {
    const a = assembleRobot(reg, def);
    if (!a.legality.legal) return false;
    if (def.partner) {
      const p = assemblePartner(reg, def);
      if (a.weightLb + p.weightLb > reg.rules.weightClass.cap + reg.rules.weightClass.tolerance) return false;
    }
    return true;
  } catch { return false; }
}

const SINGLE = ["weaponMotor", "weapon", "motor", "battery", "electronics", "drive", "wheel"];

/**
 * Part swaps a team could afford that are a step UP (cost more than what is
 * fitted), legal, and keep the body's weapon style. Cheapest first.
 */
function upgradeCandidates(reg, def, bank, cfg) {
  const out = [];
  const b = def.build;
  const try1 = (build, cost, note) => {
    if (cost > bank) return;
    const d = { ...def, build };
    if (legal(reg, d)) out.push({ def: d, cost, note });
  };
  for (const slot of SINGLE) {
    const cur = b[slot] ? reg.part(b[slot]) : null;
    if (!cur) continue;
    for (const p of reg.partsIn(slot)) {
      if (p.id === cur.id || (p.cost ?? 0) <= (cur.cost ?? 0)) continue;
      if (slot === "weapon" && !sameMount(p, cur)) continue;
      if (slot === "wheel" && p.spec.diameterIn !== cur.spec.diameterIn) continue;   // wheels set the ride height
      const cost = Math.round((p.cost ?? 0) - (cur.cost ?? 0) * cfg.resale);
      try1({ ...b, [slot]: p.id }, cost, `${labelOf(slot)}: ${cur.name} -> ${p.name}`);
    }
  }
  // Armour, panel by panel, same face.
  (b.armor || []).forEach((aid, i) => {
    const cur = reg.part(aid);
    for (const p of reg.partsIn("armor")) {
      if (p.id === cur.id || p.spec.slot !== cur.spec.slot || (p.hp ?? 0) <= (cur.hp ?? 0)) continue;
      const armor = b.armor.slice(); armor[i] = p.id;
      const cost = Math.round((p.cost ?? 0) - (cur.cost ?? 0) * cfg.resale);
      try1({ ...b, armor }, cost, `${cur.spec.slot} armour: ${cur.name} -> ${p.name}`);
    }
  });
  return out.sort((x, y) => x.cost - y.cost);
}

/** A weapon swap that the body still carries: same class, same style. */
function sameMount(p, cur) {
  return p.spec.class === cur.spec.class && (p.spec.style ?? null) === (cur.spec.style ?? null) &&
    !/shell|lid|tri/.test(p.id) === !/shell|lid|tri/.test(cur.id);
}

const LABELS = { weaponMotor: "weapon motor", weapon: "weapon", motor: "drive motors", battery: "batteries", electronics: "electronics", drive: "drivetrain", wheel: "wheels" };
const labelOf = (slot) => LABELS[slot] || slot;

/**
 * A new weapon for a slumping robot: only for front-weapon bodies, which can
 * carry any of these, and only if the team's tests say it fights better.
 */
const REDESIGNS = [
  { cls: "spinner_v", weapon: "spinner_v_disc", label: "a vertical spinner", archetype: "spinner_v" },
  { cls: "drum", weapon: "drum_kinetic", label: "a drum spinner", archetype: "drum" },
  { cls: "spinner_v", weapon: "spinner_v_small", label: "a compact vertical spinner", archetype: "spinner_v" },
  { cls: "flipper", weapon: "flipper_electric", label: "a flipper", archetype: "flipper" },
];
function redesign(reg, def, rng, test, minGain) {
  const mount = def.body?.mount || "front";
  if (mount !== "front" || def.partner) return null;
  const cur = reg.part(def.build.weapon).spec.class;
  const now = test(def);
  let best = null;
  for (const r of rng.shuffle(REDESIGNS)) {
    if (r.cls === cur) continue;
    const build = { ...def.build, weapon: r.weapon };
    if (familyOf(r.cls) === "kinetic" && !build.weaponMotor) build.weaponMotor = "wmotor_light";
    const d = { ...def, build, archetype: r.archetype };
    if (!legal(reg, d)) continue;
    const w = test(d);
    if (w > now + minGain && (!best || w > best.w)) best = { def: d, w, label: r.label };
  }
  return best;
}
