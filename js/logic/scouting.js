// scouting.js - the career's scouting reports: how an opponent has been
// fighting (its form, how it wins, how it loses, what it does against each
// kind of weapon) and the tape of its last fight, to watch in the arena.
//
// The robot's spec sheet - weapon, armour gaps, speed - is catalog.js
// scouting(); this is its record. Pure logic over the career save:
//
//   career.tape = { robotId: { season, id, a, b, stage, label, result, arena } }
//
// is every robot's last fight, kept across seasons (the season's fixtures
// are replaced at the start of the next), recorded by career.js.

import { careerArena } from "./arenas.js";
import { roundName } from "./tournament.js";

const LEAGUES = { rookie: "Rookie", pro: "Pro", elite: "Elite", world: "World Championship" };

const METHOD = { ko: "knockout", tapout: "tap out", decision: "decision" };
const CLASS_WORDS = { spinner_h: "horizontal spinners", spinner_v: "vertical spinners", drum: "drums", hammer: "hammers", flipper: "flippers", lifter: "lifters", crusher: "crushers", static: "wedges and pushers", none: "robots with no weapon" };
const CAUSE_WORDS = { flipped: "flipped over", beached: "beached", disabled: "disabled", stuck: "stuck", pitted: "shoved down the pit" };
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Keep a fight as the last one for both robots in it. */
export function recordTape(reg, career, season, f, result) {
  career.tape ||= {};
  const bracket = f.stage === "final" ? (f.league === "giantNut" ? season.giantNut?.bracket : season.leagues?.[f.league]?.finals) : null;
  const where = f.league === "giantNut" ? "Giant Nut " : f.stage === "final" ? `${LEAGUES[f.league] || f.league} ` : "";
  const label = f.stage === "grudge" ? "a grudge match"
    : f.stage === "group" ? `${where}Group ${f.group} · round ${f.round + 1}`
      : bracket ? `${where}${roundName(bracket, f.bracketRound)}` : null;
  const entry = {
    season: season.index, id: f.id, a: f.a, b: f.b, stage: f.stage, league: f.league, label,
    result: { winnerId: result.winnerId, method: result.method, cause: result.cause ?? null, elapsedS: Math.round(result.elapsedS ?? 0), decision: result.decision ?? null },
    arena: careerArena(reg, { seasonKind: f.league === "giantNut" ? "giantNut" : "league", league: f.league, fixtureId: f.id }),
  };
  career.tape[f.a] = entry;
  career.tape[f.b] = entry;
}

/** Every fight a robot has had this season, in order. */
export function seasonFights(career, id) {
  const s = career.season;
  if (!s) return [];
  const groups = s.fixtures.filter((f) => f.result && (f.a === id || f.b === id)).sort((x, y) => x.round - y.round);
  const finals = (s.finalsLog || []).filter((f) => f.a === id || f.b === id);
  return [...groups, ...finals];
}

/**
 * The scouting file on a robot: its record this season and how it gets it.
 * @returns { record: { w, l }, form: [{ won, method, oppId }], lines: [text], vs: [{ cls, w, l }], tape }
 *   lines are plain sentences for the report; `nameOf` names a robot.
 */
export function scoutReport(reg, career, id, { nameOf = (x) => x, myClass = null } = {}) {
  const fights = seasonFights(career, id).map((f) => {
    const r = f.result;
    const other = f.a === id ? f.b : f.a;
    return { oppId: other, won: r.winnerId === id, method: r.method, cause: r.cause, elapsedS: r.elapsedS ?? 180,
      dealt: r.damage?.[id] ?? 0, taken: r.damage?.[other] ?? 0 };
  });
  const wins = fights.filter((x) => x.won), losses = fights.filter((x) => !x.won);
  const koWins = wins.filter((x) => x.method === "ko" || x.method === "tapout");
  const koLosses = losses.filter((x) => x.method === "ko" || x.method === "tapout");
  const lines = [];
  if (fights.length) {
    if (wins.length) {
      if (koWins.length >= Math.ceil(wins.length / 2)) {
        const avg = koWins.reduce((t, x) => t + x.elapsedS, 0) / koWins.length;
        lines.push(`A finisher: ${koWins.length} of its ${wins.length} win${wins.length > 1 ? "s" : ""} by knockout, on average at ${clock(avg)}.`);
      } else lines.push(`Wins on points: ${wins.length - koWins.length} of its ${wins.length} win${wins.length > 1 ? "s" : ""} went to the judges.`);
    }
    if (koLosses.length) {
      const causes = {};
      for (const x of koLosses) if (x.cause) causes[x.cause] = (causes[x.cause] || 0) + 1;
      const top = Object.entries(causes).sort((a, b) => b[1] - a[1])[0];
      lines.push(`Knocked out ${koLosses.length} time${koLosses.length > 1 ? "s" : ""} this season${top ? `, ${top[1] > 1 ? "mostly " : ""}${CAUSE_WORDS[top[0]] || `with its ${top[0].replace(/([A-Z])/g, " $1").toLowerCase()} wrecked`}` : ""}.`);
    } else if (losses.length) lines.push(`Never knocked out this season: it loses on points if it loses.`);
    const dealt = fights.reduce((t, x) => t + x.dealt, 0) / fights.length;
    const taken = fights.reduce((t, x) => t + x.taken, 0) / fights.length;
    if (dealt > 0 || taken > 0) {
      lines.push(dealt > taken * 1.4 ? `Does far more damage than it takes (${Math.round(dealt)} to ${Math.round(taken)} a fight on the judges' cards).`
        : taken > dealt * 1.4 ? `Takes more damage than it deals (${Math.round(taken)} to ${Math.round(dealt)} a fight): it can be hurt.`
          : `Trades evenly: about ${Math.round(dealt)} damage dealt and ${Math.round(taken)} taken a fight.`);
    }
    const streak = [];
    for (let i = fights.length - 1; i >= 0 && fights[i].won === fights[fights.length - 1].won; i--) streak.push(fights[i]);
    if (streak.length >= 3) lines.push(`${streak[0].won ? "On a run" : "Out of form"}: ${streak.length} ${streak[0].won ? "wins" : "losses"} in a row.`);
  }
  // What it has learned against each kind of weapon (ailearn.js), most fought first.
  const vs = Object.entries(career.ai?.[id]?.vs || {}).filter(([, v]) => v.f > 0)
    .map(([cls, v]) => ({ cls, w: v.w, l: v.f - v.w, name: CLASS_WORDS[cls] || cls }))
    .sort((a, b) => (b.w + b.l) - (a.w + a.l)).slice(0, 3);
  const mine = myClass && career.ai?.[id]?.vs?.[myClass];
  if (mine && mine.f >= 2) {
    const share = mine.w / mine.f;
    lines.push(`Against ${CLASS_WORDS[myClass] || myClass} like yours: ${mine.w}-${mine.f - mine.w}${share >= 0.65 ? " - it knows how to beat your kind" : share <= 0.35 ? " - your kind of weapon troubles it" : ""}.`);
  }
  const tape = tapeOf(career, id);
  return {
    record: { w: wins.length, l: losses.length },
    form: fights.slice(-5).map((x) => ({ won: x.won, method: x.method, oppId: x.oppId })),
    lines, vs, tape,
    tapeText: tape ? tapeLine(tape, id, nameOf) : null,
  };
}

/** A robot's last fight, if it has had one in this career. */
export function tapeOf(career, id) {
  return career.tape?.[id] || null;
}

/** "Season 2, Group B · round 3: beat Gyrator by knockout at 1:12." */
export function tapeLine(tape, id, nameOf = (x) => x) {
  const r = tape.result;
  const other = tape.a === id ? tape.b : tape.a;
  const won = r.winnerId === id;
  const how = r.method === "decision" ? `on a ${r.decision || ""} decision`.replace("  ", " ") : `by ${METHOD[r.method] || r.method} at ${clock(r.elapsedS)}`;
  return `Season ${tape.season}${tape.label ? `, ${tape.label}` : ""}: ${won ? "beat" : "lost to"} ${nameOf(other)} ${how}.`;
}
