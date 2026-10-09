// cup.js - tournament mode: a one-off tournament outside the career.
//
// Three formats (data/league.json `cup`):
//   knockout   a seeded single-elimination bracket (byes for the top seeds)
//   groups     groups of four, round robin, the top two of each into a
//              seeded bracket
//   giantNut   the real thing: 120 robots, ten groups of twelve, eight fights
//              each, the top six of every group into a 64 bracket
//
// Any entrant can be driven by a person - one player, or friends taking
// turns (two at a time share the keyboard in a fight between them). Every
// fight without a person in it is settled by the fast resolver; a person's
// fight waits to be fought in the arena (fight.html?tourney=1 hands the
// result back) or handed to the AI. Robots are repaired between fights.
//
// Pure logic over a plain JSON object - the cup is its own save. The formats
// are tournament.js; this file only runs one.

import { makeRng, hashSeed } from "../core/rng.js";
import { roundRobin, partialRoundRobin, standings, compareRows, makeBracket, recordBracket, openMatches, champion, bracketFinish, roundName, nextPow2 } from "./tournament.js";
import { resolveFight } from "./resolver.js";
import { venueOf, venueIds, layoutOf, layoutForFight } from "./arenas.js";

export const CUP_SCHEMA = "cup/1";
const GROUP_NAMES = "ABCDEFGHIJKLMNOP".split("");

/** Formats and sizes (league.json `cup`), with defaults. */
export function cupConfig(reg) {
  const c = reg.league.cup || {};
  return {
    formats: c.formats || [
      { id: "knockout", name: "Knockout", sizes: [4, 8, 16, 32, 64], blurb: "One bracket. Lose once and you are out." },
      { id: "groups", name: "Groups, then knockout", sizes: [8, 16, 32, 64], blurb: "Groups of four fight a round robin; the top two of each go into the bracket." },
      { id: "giantNut", name: "The Giant Nut", sizes: [120], blurb: "All 120 robots: ten groups of twelve, eight fights each, a 64-robot bracket." },
    ],
    groupSize: c.groupSize ?? 4,
    advance: c.advance ?? 2,
    maxPlayers: c.maxPlayers ?? 8,
  };
}

/** The id a person's own robot (brought from their career) races under in a cup. */
export const customId = (slot) => `cup_custom_${slot}`;

/**
 * A new tournament.
 * @param opts.format   "knockout" | "groups" | "giantNut"
 * @param opts.size     entrants (ignored for the Giant Nut: the whole field)
 * @param opts.players  [{ name, robot, def? }] - the people, each with a
 *                      robot id from the field, or `def` (a robot they built,
 *                      raced under customId(i))
 * @param opts.fill     who else is in: "random", "top" (the best-rated) or a league id
 * @param opts.venue    a venue id, or "rounds" (it moves up the venues as the cup goes on)
 * @param opts.layout   a layout id, or "random" (from the venue's rotation, by fight)
 */
export function makeCup(reg, { name = "Tournament", format = "knockout", size = 8, players = [], fill = "random", seed = 1, venue = "rounds", layout = "random" } = {}) {
  const cfg = cupConfig(reg);
  if (!cfg.formats.some((f) => f.id === format)) throw new Error(`no cup format ${format}`);
  const rng = makeRng(hashSeed(`cup:${seed}`));
  const field = reg.roster().map((r) => r.id);
  // The people and their robots.
  const custom = {};
  const humans = {};
  players.slice(0, cfg.maxPlayers).forEach((p, i) => {
    let id = p.robot;
    if (p.def) { id = customId(i); custom[id] = { ...p.def, id, league: p.def.league || "rookie", rating: p.def.rating ?? 50, team: p.name || `Player ${i + 1}` }; }
    if (!id || (!custom[id] && !reg.hasRobot(id))) throw new Error(`player ${i + 1} has no robot`);
    if (humans[id] != null) throw new Error(`two players picked ${reg.hasRobot(id) ? reg.robot(id).name : id}`);
    humans[id] = i;
  });
  const n = format === "giantNut" ? field.length : Math.max(2, size);
  // Everyone else, by the fill rule.
  const taken = new Set(Object.keys(humans));
  let pool = field.filter((id) => !taken.has(id));
  const rating = (id) => (custom[id]?.rating ?? reg.robot(id).rating);
  if (fill === "top") pool.sort((a, b) => rating(b) - rating(a) || (a < b ? -1 : 1));
  else if (reg.league.leagues.includes(fill)) {
    const inLeague = pool.filter((id) => reg.robot(id).league === fill);
    pool = [...rng.shuffle(inLeague), ...rng.shuffle(pool.filter((id) => reg.robot(id).league !== fill))];
  } else pool = rng.shuffle(pool);
  const entrants = [...Object.keys(humans), ...pool].slice(0, Math.max(n, Object.keys(humans).length));

  const cup = {
    schema: CUP_SCHEMA, version: 1, name: String(name).trim().slice(0, 40) || "Tournament", format, seed,
    players: players.slice(0, cfg.maxPlayers).map((p, i) => ({ name: String(p.name || "").trim().slice(0, 20) || `Player ${i + 1}` })),
    humans, custom, entrants, venue, layout,
    ratings: Object.fromEntries(entrants.map((id) => [id, rating(id)])),
    round: 0, groups: null, groupRounds: 0, fixtures: [], bracket: null, bracketRounds: 0, done: false, champion: null, log: [],
  };
  const seeded = entrants.slice().sort((a, b) => cup.ratings[b] - cup.ratings[a] || (a < b ? -1 : 1));
  if (format === "knockout") {
    cup.bracket = makeBracket(seeded, nextPow2(entrants.length));
    cup.bracketRounds = cup.bracket.rounds.length;
  } else {
    const gn = format === "giantNut" ? reg.league.giantNut : null;
    const G = gn ? gn.groups : Math.max(2, Math.round(entrants.length / cfg.groupSize));
    // Pots by rating: one from each pot of G per group.
    const groups = Array.from({ length: G }, () => []);
    for (let p = 0; p < seeded.length; p += G) rng.shuffle(seeded.slice(p, p + G)).forEach((id, i) => groups[i % G].push(id));
    cup.groups = groups.map((ids, i) => ({ name: GROUP_NAMES[i], ids }));
    for (const g of cup.groups) {
      const rounds = gn && g.ids.length % 2 === 0 && gn.fightsEach < g.ids.length - 1 ? partialRoundRobin(g.ids, gn.fightsEach, rng) : roundRobin(g.ids);
      rounds.forEach((pairs, round) => {
        for (const [a, b] of pairs) cup.fixtures.push({ id: `g:${g.name}:${round}:${a}:${b}`, stage: "group", group: g.name, round, a, b, result: null });
      });
      cup.groupRounds = Math.max(cup.groupRounds, rounds.length);
    }
    cup.advance = gn ? gn.advance : cfg.advance;
    cup.bracketSize = gn ? gn.bracket : nextPow2(cup.groups.length * cup.advance);
    cup.bracketRounds = Math.log2(cup.bracketSize);
  }
  cup.totalRounds = cup.groupRounds + cup.bracketRounds;
  return cup;
}

/** Register a cup's own robots (people's career robots) with the registry. */
export function registerCupRobots(reg, cup) {
  for (const def of Object.values(cup?.custom || {})) reg.addRobot(def);
}

/** The robot def a cup entrant fights as. */
export const cupDef = (reg, cup, id) => cup.custom?.[id] || reg.robot(id);

/** Is this robot driven by a person? Their player index, or null. */
export const humanOf = (cup, id) => (cup.humans?.[id] ?? null);
const hasHuman = (cup, f) => humanOf(cup, f.a) != null || humanOf(cup, f.b) != null;

/** Fights still to fight this round. */
export function cupPending(cup) {
  if (cup.done) return [];
  if (cup.round < cup.groupRounds) return cup.fixtures.filter((f) => f.round === cup.round && !f.result);
  const br = cup.round - cup.groupRounds;
  return openMatches(cup.bracket).filter((m) => m.round === br)
    .map((m) => ({ id: `k:${m.round}:${m.index}`, stage: "final", bracketRound: m.round, index: m.index, a: m.a, b: m.b }));
}

/** The next fight a person has to fight (or hand to the AI), or null. */
export function nextCupFight(cup) {
  return cupPending(cup).find((f) => hasHuman(cup, f)) || null;
}

/** A fixture's seed, the same every time. */
export const cupSeed = (cup, f) => hashSeed(`${cup.seed}:${f.id}`) & 0x7fffffff;

/** What a cup keeps of a fight. */
function compact(r, by) {
  return { winnerId: r.winnerId, loserId: r.loserId, method: r.method, cause: r.cause ?? null, elapsedS: Math.round(r.elapsedS ?? 0),
    decision: r.decision ?? null, damage: Object.fromEntries(Object.entries(r.sides || {}).map(([id, s]) => [id, s.damageScore])), by };
}

/** Settle a fight with the resolver (both robots fresh). */
function resolve(reg, cup, f) {
  return compact(resolveFight(reg, cupDef(reg, cup, f.a), cupDef(reg, cup, f.b), { seed: cupSeed(cup, f) }), "sim");
}

/** Store a result and move the cup on as far as it goes without a person. */
export function recordCupResult(reg, cup, fixtureId, result) {
  const f = cupPending(cup).find((x) => x.id === fixtureId);
  if (!f) throw new Error(`no pending cup fight ${fixtureId}`);
  if (result.winnerId !== f.a && result.winnerId !== f.b) throw new Error(`${result.winnerId} is not in ${fixtureId}`);
  store(cup, f, { ...result, loserId: result.winnerId === f.a ? f.b : f.a });
  return advanceCup(reg, cup);
}

/** Hand a person's fight to the AI: the resolver fights it. */
export function simulateCupFight(reg, cup, fixtureId) {
  const f = cupPending(cup).find((x) => x.id === fixtureId);
  if (!f) throw new Error(`no pending cup fight ${fixtureId}`);
  const r = resolve(reg, cup, f);
  store(cup, f, r);
  advanceCup(reg, cup);
  return r;
}

function store(cup, f, result) {
  if (f.stage === "group") cup.fixtures.find((x) => x.id === f.id).result = result;
  else recordBracket(cup.bracket, f.bracketRound, f.index, result);
  cup.log.push({ id: f.id, stage: f.stage, group: f.group ?? null, round: cup.round, bracketRound: f.bracketRound ?? null, a: f.a, b: f.b, result });
}

/**
 * Fight every pending fight with no person in it, round after round, until a
 * person's fight is waiting or the cup is over.
 * @returns the fights resolved, in order
 */
export function advanceCup(reg, cup) {
  const out = [];
  for (let guard = 0; guard < 400 && !cup.done; guard++) {
    for (const f of cupPending(cup)) {
      if (hasHuman(cup, f)) continue;
      const r = resolve(reg, cup, f);
      store(cup, f, r);
      out.push({ fixture: f, result: r });
    }
    if (cupPending(cup).length) break;
    nextRound(cup);
  }
  return out;
}

function nextRound(cup) {
  cup.round++;
  if (cup.round === cup.groupRounds && cup.groups) drawBracket(cup);
  if (cup.round >= cup.totalRounds) {
    cup.done = true;
    cup.champion = champion(cup.bracket);
  }
}

/** Group tables: { group: rows }. */
export function cupTables(cup) {
  if (!cup.groups) return {};
  return Object.fromEntries(cup.groups.map((g) => [g.name, standings(g.ids, cup.fixtures.filter((f) => f.group === g.name))]));
}

/** After the groups: the top of every group into the bracket, seeded by finishing place, then record. */
function drawBracket(cup) {
  const tables = Object.values(cupTables(cup));
  const seeded = [];
  for (let pos = 0; pos < cup.advance; pos++) seeded.push(...tables.map((rows) => rows[pos]).filter(Boolean).sort(compareRows));
  cup.bracket = makeBracket(seeded.map((r) => r.id), cup.bracketSize);
}

/** How far each robot got, best first: [{ id, finish, rounds }]. */
export function cupRanking(cup) {
  const fin = cup.bracket ? bracketFinish(cup.bracket) : {};
  return cup.entrants.map((id) => ({ id, finish: fin[id] ?? -1 })).sort((a, b) => b.finish - a.finish || (cup.ratings[b.id] - cup.ratings[a.id]));
}

/** "Group B · round 2" / "Quarterfinals". */
export function cupStageLabel(cup, f) {
  if (f.stage === "group") return `Group ${f.group} · round ${f.round + 1}`;
  return cup.bracket ? roundName(cup.bracket, f.bracketRound) : "Bracket";
}

/**
 * Where a fight is: the cup's venue (or, for "rounds", the venues in order
 * from the first round to the final, the final in the biggest), on its
 * layout or one from the venue's rotation by the fight's seed.
 */
export function cupArena(reg, cup, f) {
  let venue = cup.venue;
  if (!venueOf(reg, venue)) {
    const all = venueIds(reg);
    const big = cup.format === "giantNut" ? all : all.filter((v) => v !== "giantNut");
    const at = cup.round / Math.max(1, cup.totalRounds - 1);
    venue = cup.done ? big[big.length - 1] : big[Math.min(big.length - 1, Math.floor(at * big.length))];
    if (cup.format === "giantNut") venue = "giantNut";
  }
  const layout = layoutOf(reg, cup.layout) ? cup.layout : layoutForFight(reg, venue, cupSeed(cup, f));
  return { venue, layout };
}

/** The cup as a save string, and back. */
export const serializeCup = (cup) => JSON.stringify(cup);
export function deserializeCup(text) {
  const c = JSON.parse(text);
  if (!c || c.schema !== CUP_SCHEMA) throw new Error("not a ROBO LEAGUE tournament");
  return c;
}
