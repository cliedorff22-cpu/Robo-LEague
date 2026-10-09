// halloffame.js - what outlasts a career.
//
// The Hall of Fame is kept apart from any one career (the menu saves it under
// its own key) and grows every time a career is retired: the team's entry -
// its record, titles, Giant Nuts, every robot it built - the AI robots that
// became legends in that career, and the all-time records across all of them.
//
// Pure logic over plain JSON, like the career.

import { nemesisOf } from "./rivalry.js";
import { garageOf } from "./garage.js";

export const HOF_SCHEMA = "halloffame/1";

/** An empty hall. */
export function emptyHall() {
  return { schema: HOF_SCHEMA, careers: [], legends: [], records: {} };
}

/** A hall from storage, or a fresh one if there is none (or it is junk). */
export function loadHall(text) {
  try {
    const h = JSON.parse(text || "null");
    if (h && h.schema === HOF_SCHEMA) return { ...emptyHall(), ...h };
  } catch { /* fall through */ }
  return emptyHall();
}

/** Who the AI legends of a career are: by titles won in it. */
export const LEGEND_RULES = { worldTitles: 3, giantNuts: 2, both: [2, 1] };

/**
 * The AI robots that dominated this career: three World Championships, two
 * Giant Nuts, or two Worlds and a Giant Nut.
 */
export function legendsOf(reg, career) {
  const tally = {};
  const get = (id) => (tally[id] ||= { worldTitles: 0, giantNuts: 0, titles: {}, first: Infinity, last: 0 });
  for (const h of career.history || []) {
    if (h.kind === "league" && h.champions) {
      for (const [lg, id] of Object.entries(h.champions)) {
        if (!id || id === career.playerId) continue;
        const t = get(id);
        t.titles[lg] = (t.titles[lg] || 0) + 1;
        if (lg === "world") t.worldTitles++;
        t.first = Math.min(t.first, h.season); t.last = Math.max(t.last, h.season);
      }
    }
  }
  for (const g of career.giantNutHistory || []) {
    if (!g.champion || g.champion === career.playerId) continue;
    const t = get(g.champion);
    t.giantNuts++;
    t.first = Math.min(t.first, g.season); t.last = Math.max(t.last, g.season);
  }
  const L = LEGEND_RULES;
  return Object.entries(tally)
    .filter(([, t]) => t.worldTitles >= L.worldTitles || t.giantNuts >= L.giantNuts || (t.worldTitles >= L.both[0] && t.giantNuts >= L.both[1]))
    .map(([id, t]) => {
      const r = reg.robot(id);
      return { id, name: r.name, team: r.team || "", inspiredBy: r.inspiredBy || null, livery: r.livery || {},
        worldTitles: t.worldTitles, giantNuts: t.giantNuts, titles: t.titles, seasons: [t.first, t.last], version: career.evolution?.[id]?.version || "1.0" };
    })
    .sort((a, b) => b.giantNuts * 3 + b.worldTitles - (a.giantNuts * 3 + a.worldTitles));
}

/** The best the player reached: { league, giantNut: finish label or null }. */
function bestOf(reg, career) {
  const order = reg.league.leagues;
  let best = 0;
  for (const h of career.history || []) for (const lg of [h.league, h.nextLeague]) if (lg) best = Math.max(best, order.indexOf(lg));
  best = Math.max(best, order.indexOf(career.membership?.[career.playerId] ?? order[0]));
  let gn = null;
  for (const g of career.giantNutHistory || []) {
    if (g.champion === career.playerId) { gn = "Champion"; break; }
    if (g.finish?.stage === "final") {
      const left = g.finish.rounds - g.finish.finish;
      const label = left === 1 ? "Final" : left === 2 ? "Semi-final" : left === 3 ? "Quarter-final" : `Last ${64 >> g.finish.finish}`;
      if (!gn || rank(label) > rank(gn)) gn = label;
    }
  }
  return { league: order[best], giantNut: gn };
}
const rank = (l) => ({ Champion: 9, Final: 8, "Semi-final": 7, "Quarter-final": 6 }[l] ?? (l ? 1 : 0));

/** A retiring career's entry in the Hall of Fame. */
export function careerEntry(reg, career) {
  const g = garageOf(reg, career);
  const s = career.stats;
  const robots = [...(g.museum || []), {
    name: g.name, version: g.version, from: g.record?.since ?? 1, to: career.seasonIndex,
    fights: g.record?.fights ?? s.fights, wins: g.record?.wins ?? s.wins, kos: g.record?.kos ?? s.kos, titles: g.record?.titles ?? 0,
    weapon: g.build.weapon ? reg.part(g.build.weapon).name : "None", livery: g.livery,
  }];
  const giantNuts = (career.giantNutHistory || []).filter((x) => x.champion === career.playerId).length;
  return {
    id: `${career.seed}:${career.team}:${career.seasonIndex}`,
    team: career.team,
    seasons: career.seasonIndex,
    record: { fights: s.fights, wins: s.wins, losses: s.losses, kos: s.kos },
    titles: (career.trophies || []).map((t) => ({ season: t.season, title: t.title, robot: t.robot || null })),
    giantNuts,
    best: bestOf(reg, career),
    earned: Math.round(career.earned ?? 0),
    cash: Math.round(career.cash),
    records: { bestStreak: s.bestStreak || 0, fastestKoS: s.fastestKoS ?? null, mostDamage: Math.round(s.mostDamage || 0) },
    robots,
    legends: legendsOf(reg, career).map((l) => l.id),
    nemesis: (() => { const n = nemesisOf(reg, career); return n ? { name: reg.hasRobot(n.id) ? reg.robot(n.id).name : n.id, w: n.w, l: n.l, fights: n.fights } : null; })(),
    score: careerScore(career, giantNuts),
  };
}

/** One number to rank careers by: titles, Giant Nuts, then wins. */
function careerScore(career, giantNuts) {
  const titles = career.trophies || [];
  const worlds = titles.filter((t) => t.league === "world").length;
  return giantNuts * 40 + worlds * 20 + (titles.length - worlds) * 6 + (career.stats.wins || 0) * 0.5;
}

/**
 * Put a retiring career into the hall (once), with its legends, and work the
 * all-time records out again. Returns the hall.
 */
export function induct(reg, hall, career) {
  const entry = careerEntry(reg, career);
  const h = { ...emptyHall(), ...hall };
  if (!h.careers.some((c) => c.id === entry.id)) h.careers = [...h.careers, entry].sort((a, b) => b.score - a.score);
  for (const l of legendsOf(reg, career)) {
    const key = `${entry.id}:${l.id}`;
    if (!h.legends.some((x) => x.key === key)) h.legends = [...h.legends, { ...l, key, era: entry.team }];
  }
  h.legends.sort((a, b) => b.giantNuts * 3 + b.worldTitles - (a.giantNuts * 3 + a.worldTitles));
  h.records = recordsOf(h.careers);
  return h;
}

/** The all-time records across every career in the hall. */
export function recordsOf(careers) {
  const best = (pick, better) => {
    let top = null;
    for (const c of careers) {
      const v = pick(c);
      if (v == null || v === 0) continue;
      if (!top || better(v, top.value)) top = { value: v, team: c.team };
    }
    return top;
  };
  return {
    mostTitles: best((c) => c.titles.length, (a, b) => a > b),
    mostGiantNuts: best((c) => c.giantNuts, (a, b) => a > b),
    mostWins: best((c) => c.record.wins, (a, b) => a > b),
    bestStreak: best((c) => c.records.bestStreak, (a, b) => a > b),
    fastestKoS: best((c) => c.records.fastestKoS, (a, b) => a < b),
    mostDamage: best((c) => c.records.mostDamage, (a, b) => a > b),
    longestCareer: best((c) => c.seasons, (a, b) => a > b),
  };
}
