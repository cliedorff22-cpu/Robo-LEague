// tournament.js - the formats: round-robin groups, standings, wild cards and
// single-elimination brackets.
//
// Pure logic on robot ids and fight results. No robots, no physics, no money:
// season.js decides WHO is drawn into what, this file only knows how a format
// works. Every draw that needs chance takes a seeded rng.

/**
 * Round-robin rounds by the circle method: every robot meets every other once,
 * and each round nobody fights twice. With an odd count one robot sits out
 * each round (a bye).
 * @returns [[ [a, b], ... ], ...]  rounds of pairings
 */
export function roundRobin(ids) {
  const list = ids.slice();
  if (list.length % 2) list.push(null);
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      if (a !== null && b !== null) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    // Keep the first fixed, rotate the rest one place.
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

/**
 * A partial round robin: every robot fights exactly `k` of the others, one
 * fight per round, nobody twice. Takes `k` of the full round robin's rounds
 * (an even group gives a perfect matching per round), chosen by the rng so
 * which three opponents a robot misses is a draw, not always the same.
 */
export function partialRoundRobin(ids, k, rng) {
  if (ids.length % 2) throw new Error("partialRoundRobin needs an even group");
  const all = roundRobin(rng ? rng.shuffle(ids) : ids);
  if (k > all.length) throw new Error(`a group of ${ids.length} has only ${all.length} rounds`);
  const picked = rng ? rng.shuffle(all.map((_, i) => i)).slice(0, k).sort((x, y) => x - y) : all.map((_, i) => i).slice(0, k);
  return picked.map((i) => all[i]);
}

/**
 * Standings from results. A row per robot:
 *   { id, played, wins, losses, kos, koLosses, damage, damageTaken }
 * sorted by wins, then knockouts, then damage score - the brief's order for
 * groups, wild cards and the Giant Nut alike. `damage` is the judges' damage
 * score the robot dealt (hp plus failure bonuses), summed over its fights.
 *
 * @param ids      every robot in the table (a robot with no fights still shows)
 * @param fights   [{ a, b, result: { winnerId, method, damage: { [id]: n } } }]
 */
export function standings(ids, fights) {
  const rows = new Map(ids.map((id) => [id, { id, played: 0, wins: 0, losses: 0, kos: 0, koLosses: 0, damage: 0, damageTaken: 0 }]));
  for (const f of fights) {
    const r = f.result;
    if (!r) continue;
    for (const id of [f.a, f.b]) {
      const row = rows.get(id);
      if (!row) continue;
      const other = id === f.a ? f.b : f.a;
      row.played++;
      const won = r.winnerId === id;
      if (won) { row.wins++; if (r.method === "ko") row.kos++; }
      else { row.losses++; if (r.method === "ko") row.koLosses++; }
      row.damage += r.damage?.[id] ?? 0;
      row.damageTaken += r.damage?.[other] ?? 0;
    }
  }
  return [...rows.values()].sort(compareRows);
}

/** Wins, then KOs, then damage dealt; the id last so a sort is never ambiguous. */
export function compareRows(x, y) {
  return (y.wins - x.wins) || (y.kos - x.kos) || (y.damage - x.damage) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
}

/**
 * The best `n` rows not already through, by record then damage.
 * @param tables  [[rows sorted], ...] one per group
 * @param qualified Set of ids already in
 */
export function wildCards(tables, qualified, n) {
  return tables.flat().filter((r) => !qualified.has(r.id)).sort(compareRows).slice(0, n);
}

/**
 * Bracket slot order for `size` (a power of two): seed 1 meets the lowest seed,
 * and 1 and 2 can only meet in the final. [1, 16, 8, 9, 5, 12, 4, 13, ...].
 */
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2 + 1;
    order = order.flatMap((s) => [s, m - s]);
  }
  return order;
}

/**
 * A single-elimination bracket from robots listed in seed order. With fewer
 * robots than slots the top seeds get byes (they walk into round two).
 * @returns { size, rounds: [[match]] } where match = { a, b, winner, result, bye }
 */
export function makeBracket(seeded, size = nextPow2(seeded.length)) {
  if (seeded.length > size) throw new Error(`${seeded.length} robots do not fit a ${size} bracket`);
  const slots = seedOrder(size).map((s) => seeded[s - 1] ?? null);
  const first = [];
  for (let i = 0; i < size; i += 2) {
    const a = slots[i], b = slots[i + 1];
    const bye = !a || !b;
    first.push({ a, b, winner: bye ? (a || b) : null, result: null, bye });
  }
  const rounds = [first];
  for (let n = size / 4; n >= 1; n /= 2) rounds.push(Array.from({ length: n }, () => ({ a: null, b: null, winner: null, result: null, bye: false })));
  const bracket = { size, rounds };
  propagate(bracket);
  return bracket;
}

/** Record a bracket result and move the winner on. */
export function recordBracket(bracket, round, index, result) {
  const m = bracket.rounds[round][index];
  if (!m || !m.a || !m.b) throw new Error(`no fight at round ${round} match ${index}`);
  if (result.winnerId !== m.a && result.winnerId !== m.b) throw new Error(`${result.winnerId} is not in this fight`);
  m.result = result;
  m.winner = result.winnerId;
  propagate(bracket);
}

/** Fill later rounds from winners so far. */
function propagate(bracket) {
  for (let r = 1; r < bracket.rounds.length; r++) {
    bracket.rounds[r].forEach((m, i) => {
      const fa = bracket.rounds[r - 1][i * 2], fb = bracket.rounds[r - 1][i * 2 + 1];
      m.a = fa.winner; m.b = fb.winner;
      if (m.result && m.winner !== m.a && m.winner !== m.b) { m.result = null; m.winner = null; }
    });
  }
}

/** Fights ready to be fought: both robots known, no result yet. */
export function openMatches(bracket) {
  const out = [];
  bracket.rounds.forEach((ms, round) => ms.forEach((m, index) => {
    if (m.a && m.b && !m.winner) out.push({ round, index, a: m.a, b: m.b });
  }));
  return out;
}

/** The champion, once the final is decided. */
export const champion = (bracket) => bracket.rounds[bracket.rounds.length - 1][0].winner;

/**
 * How far each robot got: { id: roundReached } where the champion gets
 * rounds.length and a first-round loser 0 (a bye counts as winning round 0).
 */
export function bracketFinish(bracket) {
  const out = {};
  bracket.rounds.forEach((ms, r) => ms.forEach((m) => {
    for (const id of [m.a, m.b]) if (id) out[id] = Math.max(out[id] ?? 0, r);
    if (m.winner) out[m.winner] = Math.max(out[m.winner] ?? 0, r + 1);
  }));
  return out;
}

/** Display name of a round, counted back from the final. */
export function roundName(bracket, r) {
  const left = bracket.rounds.length - r;
  return left === 1 ? "Final" : left === 2 ? "Semifinals" : left === 3 ? "Quarterfinals" : `Round of ${bracket.size >> r}`;
}

export const nextPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };
