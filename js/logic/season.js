// season.js - one season of the career: a league season or the Giant Nut.
//
// Pure logic over robot ids. A season is a plain JSON object (it goes straight
// into the save file), advanced ROUND by round: a round is one fight for
// everyone scheduled, across all four leagues at once. Fights are settled by a
// `resolve(aId, bId, fixture)` function the caller supplies (the fast resolver
// for AI fights); the player's own fight is left open for them to fight, and
// recorded with recordResult() when they have.
//
// League season (data/league.json `league`), per league:
//   group stage  6 groups of 5 drawn from rating pots, round robin
//   finals       group winners and runners-up plus the 4 best of the rest,
//                a seeded 16-robot bracket
//   movement     the top 4 of the final ranking go up, the bottom 4 down
//
// Giant Nut season (`giantNut`): no leagues. 10 groups of 12, each drawn with
// three robots from every league; 8 fights each; the top 6 of every group into
// a 64 bracket seeded by group performance, the top 4 seeds on byes. It does
// not touch league membership.

import { makeRng, hashSeed } from "../core/rng.js";
import {
  roundRobin, partialRoundRobin, standings, compareRows, wildCards, makeBracket,
  recordBracket, openMatches, champion, bracketFinish,
} from "./tournament.js";

const GROUP_NAMES = "ABCDEFGHIJKLMNOP".split("");

/**
 * Start a season.
 * @param format      reg.league (data/league.json)
 * @param opts.index  season number, from 1
 * @param opts.kind   "league" | "giantNut"
 * @param opts.membership  { robotId: league } for the whole field
 * @param opts.ratings     { robotId: rating } for drawing pots
 * @param opts.seed
 */
export function makeSeason(format, { index, kind, membership, ratings, seed }) {
  const rng = makeRng(hashSeed(`season:${seed}:${index}`));
  const season = { schema: "season/1", index, kind, seed, round: 0, done: false, fixtures: [] };
  const byRating = (ids) => ids.slice().sort((x, y) => (ratings[y] ?? 0) - (ratings[x] ?? 0) || (x < y ? -1 : 1));

  if (kind === "league") {
    const f = format.league;
    season.leagues = {};
    season.groupRounds = f.groupSize - (f.groupSize % 2 ? 0 : 1);
    for (const lg of format.leagues) {
      const members = byRating(Object.keys(membership).filter((id) => membership[id] === lg));
      const groups = drawGroups(members, f.groups, rng).map((ids, g) => ({ name: GROUP_NAMES[g], ids }));
      season.leagues[lg] = { members, groups, finals: null, ranking: null, movement: null };
      for (const grp of groups) {
        roundRobin(grp.ids).forEach((pairs, round) => {
          for (const [a, b] of pairs) {
            season.fixtures.push({ id: `s${index}:${lg}:${grp.name}:${round}:${a}:${b}`, stage: "group", league: lg, group: grp.name, round, a, b, result: null });
          }
        });
      }
    }
    season.finalsRounds = Math.log2(f.finals.size);
  } else {
    const g = format.giantNut;
    // Three from every league in every group: each league's robots are drawn
    // in pots of ten by rating, one from each pot per group.
    const groups = Array.from({ length: g.groups }, () => []);
    for (const lg of format.leagues) {
      const members = byRating(Object.keys(membership).filter((id) => membership[id] === lg));
      for (let p = 0; p < members.length; p += g.groups) {
        const pot = rng.shuffle(members.slice(p, p + g.groups));
        pot.forEach((id, i) => groups[i % g.groups].push(id));
      }
    }
    season.giantNut = { groups: groups.map((ids, i) => ({ name: GROUP_NAMES[i], ids })), bracket: null, ranking: null };
    season.groupRounds = g.fightsEach;
    for (const grp of season.giantNut.groups) {
      partialRoundRobin(grp.ids, g.fightsEach, rng).forEach((pairs, round) => {
        for (const [a, b] of pairs) {
          season.fixtures.push({ id: `s${index}:gn:${grp.name}:${round}:${a}:${b}`, stage: "group", league: "giantNut", group: grp.name, round, a, b, result: null });
        }
      });
    }
    season.finalsRounds = Math.log2(g.bracket);
  }
  season.totalRounds = season.groupRounds + season.finalsRounds;
  return season;
}

/** Deal ranked robots into groups by pots: one from each pot of `n`, in a random order. */
function drawGroups(ranked, n, rng) {
  const groups = Array.from({ length: n }, () => []);
  for (let p = 0; p < ranked.length; p += n) {
    rng.shuffle(ranked.slice(p, p + n)).forEach((id, i) => groups[i % n].push(id));
  }
  return groups;
}

/** Is this round in the group stage? */
export const inGroups = (season) => season.round < season.groupRounds;

/** Fights still to be fought this round: [{ fixture | bracket ref }]. */
export function pending(season) {
  if (season.done) return [];
  if (inGroups(season)) {
    return season.fixtures.filter((f) => f.stage === "group" && f.round === season.round && !f.result);
  }
  const out = [];
  const fr = season.round - season.groupRounds;
  for (const [comp, bracket] of brackets(season)) {
    for (const m of openMatches(bracket)) {
      if (m.round !== fr) continue;
      out.push({ id: `s${season.index}:${comp}:final:${m.round}:${m.index}`, stage: "final", league: comp, round: season.round, bracketRound: m.round, index: m.index, a: m.a, b: m.b });
    }
  }
  return out;
}

/** Every bracket in play: [[competition, bracket]]. */
function brackets(season) {
  if (season.kind === "league") return Object.entries(season.leagues).filter(([, l]) => l.finals).map(([lg, l]) => [lg, l.finals]);
  return season.giantNut.bracket ? [["giantNut", season.giantNut.bracket]] : [];
}

/** The player's fight this round, if they have one still to fight. */
export function playerFixture(season, playerId) {
  return pending(season).find((f) => f.a === playerId || f.b === playerId) || null;
}

/** Store a fight's result. `result` = { winnerId, method, damage: { id: n }, ... }. */
export function recordResult(season, fixture, result) {
  if (fixture.stage === "group") {
    const f = season.fixtures.find((x) => x.id === fixture.id);
    if (!f) throw new Error(`no fixture ${fixture.id}`);
    f.result = result;
  } else {
    const bracket = fixture.league === "giantNut" ? season.giantNut.bracket : season.leagues[fixture.league].finals;
    recordBracket(bracket, fixture.bracketRound, fixture.index, result);
    (season.finalsLog ||= []).push({ ...fixture, result });
  }
}

/**
 * Fight every pending fight this round except the player's, then, if the
 * round is complete, move on (drawing the finals after the group stage and
 * closing the season after the last final). Repeats round after round until
 * the player has a fight to fight or the season is over.
 *
 * @param resolve(aId, bId, fixture) -> result
 * @returns [{ fixture, result }] everything resolved, in order
 */
export function advance(season, format, { resolve, playerId, stopForPlayer = true }) {
  const log = [];
  for (let guard = 0; guard < 200 && !season.done; guard++) {
    for (const f of pending(season)) {
      if (stopForPlayer && (f.a === playerId || f.b === playerId)) continue;
      const result = resolve(f.a, f.b, f);
      recordResult(season, f, result);
      log.push({ fixture: f, result });
    }
    if (pending(season).length) break;          // the player's fight is waiting
    nextRound(season, format);
  }
  return log;
}

/** Close the round: draw the finals after the group stage, finish after the final. */
function nextRound(season, format) {
  season.round++;
  if (season.round === season.groupRounds) startFinals(season, format);
  if (season.round >= season.totalRounds) finish(season, format);
}

/** Group tables: { competition: { group: rows } }. */
export function groupTables(season) {
  const out = {};
  const comps = season.kind === "league"
    ? Object.entries(season.leagues).map(([lg, l]) => [lg, l.groups])
    : [["giantNut", season.giantNut.groups]];
  for (const [comp, groups] of comps) {
    out[comp] = {};
    for (const g of groups) {
      out[comp][g.name] = standings(g.ids, season.fixtures.filter((f) => f.league === comp && f.group === g.name));
    }
  }
  return out;
}

function startFinals(season, format) {
  const tables = groupTables(season);
  if (season.kind === "league") {
    const f = format.league.finals;
    for (const [lg, l] of Object.entries(season.leagues)) {
      const t = l.groups.map((g) => tables[lg][g.name]);
      const winners = t.map((rows) => rows[0]).sort(compareRows);
      const runners = t.map((rows) => rows[1]).sort(compareRows);
      const through = new Set([...winners, ...runners].map((r) => r.id));
      const wild = wildCards(t, through, f.wildCards);
      l.finals = makeBracket([...winners, ...runners, ...wild].map((r) => r.id), f.size);
      l.wildCards = wild.map((r) => r.id);
    }
  } else {
    const g = format.giantNut;
    const t = season.giantNut.groups.map((grp) => tables.giantNut[grp.name]);
    // Seeded by group performance: every group winner ahead of every
    // runner-up, and so on, each tier by record.
    const seeded = [];
    for (let pos = 0; pos < g.advance; pos++) seeded.push(...t.map((rows) => rows[pos]).sort(compareRows));
    season.giantNut.bracket = makeBracket(seeded.map((r) => r.id), g.bracket);
  }
}

/**
 * The final ranking of a league: how far a robot got in the finals, then its
 * group record. Non-qualifiers follow, by record.
 */
export function leagueRanking(season, lg) {
  const l = season.leagues[lg];
  const rows = Object.values(groupTables(season)[lg]).flat();
  const row = new Map(rows.map((r) => [r.id, r]));
  const finish = l.finals ? bracketFinish(l.finals) : {};
  return l.members.slice().sort((x, y) => ((finish[y] ?? -1) - (finish[x] ?? -1)) || compareRows(row.get(x), row.get(y)));
}

function finish(season, format) {
  season.done = true;
  if (season.kind === "league") {
    const order = format.leagues;
    for (const [lg, l] of Object.entries(season.leagues)) {
      l.ranking = leagueRanking(season, lg);
      l.champion = champion(l.finals);
      const i = order.indexOf(lg);
      l.movement = {
        promoted: i < order.length - 1 ? l.ranking.slice(0, format.league.promote) : [],
        relegated: i > 0 ? l.ranking.slice(-format.league.relegate) : [],
      };
    }
  } else {
    const gn = season.giantNut;
    gn.champion = champion(gn.bracket);
    const fin = bracketFinish(gn.bracket);
    const rows = Object.values(groupTables(season).giantNut).flat();
    const row = new Map(rows.map((r) => [r.id, r]));
    gn.ranking = rows.map((r) => r.id).sort((x, y) => ((fin[y] ?? -1) - (fin[x] ?? -1)) || compareRows(row.get(x), row.get(y)));
  }
}

/** League membership after a finished league season: everyone moved up or down. */
export function nextMembership(season, membership, format) {
  if (season.kind !== "league") return { ...membership };
  const out = { ...membership };
  const order = format.leagues;
  for (const [lg, l] of Object.entries(season.leagues)) {
    const i = order.indexOf(lg);
    for (const id of l.movement.promoted) out[id] = order[i + 1];
    for (const id of l.movement.relegated) out[id] = order[i - 1];
  }
  return out;
}

/**
 * How far a robot got: { stage: "group" | "final", finish } where finish is
 * the bracket round reached (bracket rounds count up from 0; the champion
 * gets the number of rounds). null if not in this season.
 */
export function robotFinish(season, id) {
  const bracket = season.kind === "league"
    ? Object.values(season.leagues).find((l) => l.members.includes(id))?.finals
    : season.giantNut.bracket;
  if (!bracket) return { stage: "group", finish: -1 };
  const fin = bracketFinish(bracket);
  return id in fin ? { stage: "final", finish: fin[id], rounds: bracket.rounds.length } : { stage: "group", finish: -1, rounds: bracket.rounds.length };
}
