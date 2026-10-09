// judging.js - the scorebook and the judges.
//
// Pure logic. The referee (js/sim/referee.js) watches the fight and records
// facts here - hits, who was advancing, who was pushing whom, who was stuck -
// and when a match goes the distance three judges turn those facts into
// scorecards, as on the show:
//
//   damage      5 points   what you did to the other robot
//   aggression  3 points   who drove the fight and kept attacking
//   control     3 points   who dictated where it happened and used the arena
//
// Each judge splits each category's points between the two robots according to
// the share of that category each earned. Judges are people: each has a small,
// seeded lean per category, so a close fight can come out a split decision and
// a lopsided one never does. 11 points per card is odd, so a card cannot tie.

import { makeRng, hashSeed } from "../core/rng.js";
import { clamp } from "../core/vec.js";

export const CATEGORIES = ["damage", "aggression", "control"];

/** Default judging config; rules.json `judging` overrides any of it. */
const DEFAULTS = {
  judges: 3,
  // How far one judge's read of a category can differ from the facts, as a
  // share. 0.06 means a 50/50 fight can land 56/44 on one card.
  judgeLean: 0.06,
  // Damage points for a destroyed part, on top of the hp it cost.
  failureBonusHp: 35,
  // Hazard damage counts for whoever put the robot into the hazard, if they
  // touched it within this many seconds.
  hazardCreditS: 2.0,
};

export function judgingConfig(rules) {
  const j = rules.judging || {};
  const points = {};
  for (const c of j.categories || []) points[c.id] = c.points;
  return {
    ...DEFAULTS, ...j,
    points: { damage: points.damage ?? 5, aggression: points.aggression ?? 3, control: points.control ?? 3 },
  };
}

/**
 * Running tally of the facts the judges score from.
 * @param {string[]} botIds  exactly two
 */
export function makeScorebook(rules, botIds) {
  const cfg = judgingConfig(rules);
  const blank = () => ({
    damage: 0,          // hp-equivalent dealt
    hpDealt: 0, failuresCaused: 0, hazardHpCredited: 0,
    advancingS: 0, attacks: 0,
    pushingS: 0, oppDisabledS: 0, ownDisabledS: 0, selfHazardHits: 0, pinPenalties: 0,
    hitsLanded: 0, biggestHitHp: 0,
  });
  const tally = new Map(botIds.map((id) => [id, blank()]));
  const other = (id) => botIds.find((b) => b !== id);

  return {
    cfg,
    tally: (id) => tally.get(id),
    reset() { for (const id of botIds) tally.set(id, blank()); },

    /**
     * A resolved hit. `creditTo` overrides who gets the damage - used for
     * hazard hits when someone drove the victim in.
     */
    recordHit({ kind, attackerId, defenderId, hp, failures = 0, creditTo = null }) {
      const scorer = creditTo ?? (kind === "hazard" ? null : attackerId);
      const victim = tally.get(defenderId);
      if (kind === "hazard" && victim && !creditTo) victim.selfHazardHits++;
      const t = scorer && tally.get(scorer);
      if (!t || scorer === defenderId) return;
      const pts = hp + failures * cfg.failureBonusHp;
      t.damage += pts;
      t.hpDealt += hp;
      t.failuresCaused += failures;
      if (kind === "hazard") t.hazardHpCredited += hp;
      else {
        t.hitsLanded++;
        t.attacks += kind === "weapon" ? 1 : 0.5;
      }
      t.biggestHitHp = Math.max(t.biggestHitHp, hp);
    },

    /**
     * Per-step facts for one bot: { advancing, pushing, disabled }.
     * Advancing and pushing must be under the bot's OWN power - the referee
     * works that out.
     */
    recordStep(id, facts, dt) {
      const t = tally.get(id);
      if (!t) return;
      if (facts.advancing) t.advancingS += dt;
      if (facts.pushing) t.pushingS += dt;
      if (facts.disabled) {
        t.ownDisabledS += dt;
        const o = tally.get(other(id));
        if (o) o.oppDisabledS += dt;
      }
    },

    /** The pinning rule was broken: a control deduction. */
    recordPinPenalty(id) { const t = tally.get(id); if (t) t.pinPenalties++; },

    /** Raw category scores (not points) per bot. */
    raw() {
      const out = {};
      for (const id of botIds) {
        const t = tally.get(id);
        out[id] = {
          damage: t.damage,
          aggression: t.advancingS + t.attacks * 1.5,
          control: Math.max(0,
            t.pushingS + t.oppDisabledS * 0.8 + t.hazardHpCredited * 0.03 +
            tally.get(other(id)).selfHazardHits * 0.6 -
            t.ownDisabledS * 0.5 - t.pinPenalties * 4),
        };
      }
      return out;
    },

    /** Who is ahead right now, -1..1 from `id`'s point of view. For the AI. */
    lead(id) {
      const r = this.raw();
      const me = r[id], them = r[other(id)];
      if (!me || !them) return 0;
      let s = 0, w = 0;
      for (const c of CATEGORIES) {
        const tot = me[c] + them[c];
        if (tot <= 1e-6) continue;
        s += cfg.points[c] * (me[c] - them[c]) / tot;
        w += cfg.points[c];
      }
      return w ? s / w : 0;
    },

    /** Turn the tally into judges' scorecards. */
    judge(seed = 1) {
      return judgeCards(this.raw(), botIds, cfg, seed);
    },
  };
}

/**
 * Score cards from raw category scores.
 * @returns { cards: [{ judge, scores: { id: { damage, aggression, control, total } }, winnerId }],
 *            winnerId, votes: { id: n }, decision: "unanimous" | "split" }
 */
export function judgeCards(raw, botIds, cfg, seed = 1) {
  const [a, b] = botIds;
  const cards = [];
  for (let j = 0; j < cfg.judges; j++) {
    const rng = makeRng(hashSeed(`judge:${j}:${seed}`));
    const scores = { [a]: { total: 0 }, [b]: { total: 0 } };
    for (const c of CATEGORIES) {
      const pts = cfg.points[c];
      const ra = raw[a][c], rb = raw[b][c];
      const tot = ra + rb;
      // Nothing to separate them: the judge splits it as evenly as an odd
      // number of points allows, by their lean.
      let share = tot > 1e-6 ? ra / tot : 0.5;
      share = clamp(share + (rng.next() - 0.5) * 2 * cfg.judgeLean, 0, 1);
      const pa = clamp(Math.round(share * pts), 0, pts);
      scores[a][c] = pa;
      scores[b][c] = pts - pa;
      scores[a].total += pa;
      scores[b].total += pts - pa;
    }
    cards.push({ judge: j + 1, scores, winnerId: scores[a].total > scores[b].total ? a : b });
  }
  const votes = { [a]: 0, [b]: 0 };
  for (const c of cards) votes[c.winnerId]++;
  const winnerId = votes[a] > votes[b] ? a : b;
  return {
    cards, votes, winnerId,
    loserId: winnerId === a ? b : a,
    decision: votes[winnerId] === cfg.judges ? "unanimous" : "split",
  };
}
