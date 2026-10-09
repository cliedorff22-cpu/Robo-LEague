// trials.js - trial fights: a design against some opponents through the fast
// resolver, with paired seeds so two designs tested with the same salt meet
// exactly the same fights. The build advisor uses it to back its advice with
// numbers; the AI teams (ailearn.js) use it to choose their setup for a fight.

import { resolveFight } from "./resolver.js";
import { makeRng, hashSeed } from "../core/rng.js";

/**
 * Fight `def` against each opponent `seeds` times through the resolver.
 * Seeds depend only on the opponent and the salt, so two designs tested with
 * the same salt meet exactly the same fights - comparisons are paired, which
 * keeps the noise down.
 */
export function gauntlet(reg, def, opps, { seeds = 4, salt = "g", cond = null } = {}) {
  let wins = 0, n = 0;
  const byOpp = [];
  for (const o of opps) {
    let w = 0;
    for (let k = 0; k < seeds; k++) {
      const seed = hashSeed(`${salt}:${o.id}:${k}`) & 0x7fffffff;
      // Alternate corners so neither side keeps the same one.
      // `cond` = { id: [per unit condition] }: robots that turn up damaged.
      const cd = cond?.[def.id] || null, co = cond?.[o.id] || null;
      const r = k % 2 ? resolveFight(reg, o, def, { seed, conditionA: co, conditionB: cd })
        : resolveFight(reg, def, o, { seed, conditionA: cd, conditionB: co });
      if (r.winnerId === def.id) w++;
    }
    wins += w; n += seeds;
    byOpp.push({ id: o.id, name: o.name, wins: w, n: seeds });
  }
  return { winRate: n ? wins / n : 0, n, byOpp };
}

/** A stable sample of up to n from a list. */
export function sample(list, n, salt) {
  if (list.length <= n) return list;
  const rng = makeRng(hashSeed(`sample:${salt}`));
  const pool = list.slice();
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
  return out;
}
