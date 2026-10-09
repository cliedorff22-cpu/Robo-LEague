// advisor.js - the optional build advisor. Offline: no network, no API key.
//
// It never has to be used - everything it suggests can be done by hand in
// the workshop - and it only ever SUGGESTS: the player applies a design or
// not. It reasons from three things it can see:
//
//   - the parts and what build.js derives from them (weight, speed, push,
//     armour, weapon energy);
//   - data/matchups.json: how each weapon class actually does against each
//     other one in refereed physics (measured by tools/balance.sh);
//   - trial fights: it runs candidate designs through the fast resolver
//     (resolver.js) against the real opponents - the next one, or the
//     player's league - and reports the measured change, not a guess.
//
// One entry point, advise(reg, request), returning plain Advice objects. That
// shape is deliberately narrow so an LLM-backed advisor (Claude, with the
// player's own key - to be explored once the game is finished) can sit behind
// the same call and the workshop screen would not change:
//
//   request = { kind: "design" | "opponent" | "fight" | "season",
//               career?, design?, brief?, oppId?, budget? }
//   Advice  = { kind, title, summary, points: [text], design?, evidence?,
//               options?: [{ label, design, winRate, delta, cost, notes }] }

import { gauntlet, sample } from "./trials.js";
import { fieldedDef, playerLeague, wearOf } from "./career.js";
import { assembleRobot } from "./build.js";
import { garageOf, quote, canBuy, playerDef, carryCondition } from "./garage.js";
import { summarize, slotsOf, setSlot, fitBody, defOf, weaponClassOf, partsFor, reinforce, fitWithin, uniqExtras } from "./workshop.js";
import { scouting, WEAPON_NAMES } from "./catalog.js";
import { PLAYBOOK } from "./ai.js";

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const pct = (x) => `${Math.round(x * 100)}%`;
const money = (n) => `$${Math.round(n).toLocaleString()}`;
const CLASS_NAME = (c) => (WEAPON_NAMES[c] || c).toLowerCase();

/** Where each weapon class mostly lands its hits (physics and resolver agree). */
export const THREAT_FACES = {
  spinner_h: ["side", "front"], spinner_v: ["front", "top"], drum: ["front"], hammer: ["top"],
  crusher: ["top", "front"], flipper: ["front"], lifter: ["front"], static: ["front"], none: ["front"],
};
/** Classes that win by turning robots over (matchups.json winsBy agrees). */
const FLIPPERS = new Set(["flipper", "lifter", "spinner_v"]);
/** Trial fights per option against one opponent. */
const MATCH_SEEDS = 60;

// ---------------------------------------------------------------- entry point

/** Ask the advisor something. See the header for the request and the answer. */
export function advise(reg, req) {
  switch (req.kind) {
    case "design": return designFromBrief(reg, req);
    case "opponent": return tailorForOpponent(reg, req);
    case "fight": return fightPlan(reg, req);
    case "season": return seasonPlan(reg, req);
    default: throw new Error(`advisor: unknown request "${req.kind}"`);
  }
}

// ---------------------------------------------------------------- trial fights

/** The player's design as a fielded def (league applied), for the resolver. */
function myDef(reg, career, design) {
  const base = career ? playerDef(reg, career) : reg.robot(reg.playerId);
  const def = defOf(reg, design, base);
  return { ...def, league: career ? playerLeague(career) : (design.league || "rookie") };
}

/** The robots the player meets: their league's field (fielded, in a career). */
function leagueField(reg, career, league = "rookie") {
  if (career) {
    const lg = playerLeague(career);
    return Object.entries(career.membership)
      .filter(([id, l]) => l === lg && id !== career.playerId)
      .map(([id]) => fieldedDef(reg, career, id));
  }
  return reg.roster().filter((r) => r.league === league && r.id !== reg.playerId);
}


// ---------------------------------------------------------------- design from a brief

const WEAPON_WORDS = [
  [/undercut/, { cls: "spinner_h", part: "spinner_h_undercutter", mount: "low" }],
  [/shell|full[- ]body|ring spinner/, { cls: "spinner_h", part: "spinner_h_shell" }],
  [/three[- ]hammer|tri[- ]?(rotor|blade)/, { cls: "spinner_h", part: "spinner_h_tri" }],
  [/overhead|over[- ]the[- ]top spin/, { cls: "spinner_h", mount: "overhead" }],
  [/horizontal|tombstone|bar spinner|spinning bar/, { cls: "spinner_h" }],
  [/eggbeater/, { cls: "drum", part: "drum_eggbeater" }],
  [/drum|minotaur/, { cls: "drum" }],
  [/vertical|\bdis[ck]\b|bite ?force|witch doctor|blade/, { cls: "spinner_v" }],
  [/sledge/, { cls: "hammer", part: "hammer_sledge" }],
  [/hammer ?saw|\bsaw\b/, { cls: "hammer", part: "hammer_saw" }],
  [/hammer|\baxe\b|chomp|\bspike\b/, { cls: "hammer" }],
  [/lid flip/, { cls: "flipper", part: "flipper_lid", mount: "lid" }],
  [/flip|bronco|hydra/, { cls: "flipper" }],
  [/clamp/, { cls: "lifter", part: "lifter_clamp" }],
  [/lift/, { cls: "lifter" }],
  [/claw|grab/, { cls: "crusher", part: "grabber_claw" }],
  [/crush|\bbeak\b|\bjaws?\b|kraken/, { cls: "crusher" }],
];

/**
 * Read a builder's description: "a low wedge with a lifter", "fast drum,
 * lots of armour, under $15,000", "invertible vertical spinner called Molar".
 */
export function parseBrief(text) {
  const t = ` ${String(text || "").toLowerCase()} `;
  // The weapon: the first weapon word in the text. "Wedge" is the weapon only
  // when nothing else is - "a low wedge with a lifter" is a lifter on a wedge.
  let weapon = null, at = Infinity;
  for (const [re, w] of WEAPON_WORDS) {
    const m = t.match(re);
    if (m && m.index < at) { at = m.index; weapon = w; }
  }
  const wedgeWord = /wedge|pusher|rammer|\bram\b|control bot/.test(t);
  if (!weapon && wedgeWord) weapon = { cls: "static" };
  const p = {
    weapon,
    template: /twin|pods/.test(t) ? "twin" : /round|dome|circular|disc[- ]shaped/.test(t) ? "round"
      : wedgeWord || /\blow\b/.test(t) ? "wedge" : /\bslab\b|flat/.test(t) ? "slab" : /arrow|dart/.test(t) ? "dart"
      : /\bbox\b|boxy|brick/.test(t) ? "box" : null,
    chassis: /long/.test(t) ? "chassis_long" : /wide/.test(t) ? "chassis_wide" : /tall/.test(t) ? "chassis_tall_box"
      : /small|compact|tiny/.test(t) ? "chassis_compact" : /\blow\b|flat|slab/.test(t) ? "low" : null,
    invertible: /invertible|both ways|upside[- ]down|either way up/.test(t),
    srimech: /self[- ]?right|srimech/.test(t),
    extras: [/fork|wedgelet/.test(t) && "forks", /plow|plough|scoop/.test(t) && "plow", /wheel ?guard/.test(t) && "wheelGuards"].filter(Boolean),
    priorities: {
      speed: /fast|quick|speed|nimble|agile|zippy/.test(t),
      armour: /armou?r|tough|tank|durable|survive|heavy plate/.test(t),
      push: /push|strong|torque|bully|shove/.test(t),
      power: /hit hard|big hits?|damage|destruct|kinetic|energy|powerful|heavy hitter/.test(t),
      cheap: /cheap|budget|inexpensive|low[- ]cost/.test(t),
    },
    budget: null, name: null,
  };
  const b = t.match(/\$\s?([\d,.]+)\s*(k)?/) || t.match(/(?:under|budget of|for)\s+([\d,.]+)\s*(k)?\s*(?:dollars|bucks)/);
  if (b) p.budget = Math.round(parseFloat(b[1].replace(/,/g, "")) * (b[2] ? 1000 : 1));
  const n = String(text || "").match(/(?:called|named)\s+["']?([A-Za-z0-9][\w' &-]{0,26}?)["']?(?:[,.;!]|\s+(?:with|and|that|which)\b|$)/i);
  if (n) p.name = n[1].trim();
  return p;
}

/** How well a design matches what was asked for, on top of its trial-fight results. */
function briefScore(sum, p, chassis) {
  // Unused weight is wasted armour or power, whatever was asked for.
  let s = -Math.max(0, sum.spareLb - 4) * 0.15;
  const pr = p.priorities;
  if (pr.speed) s += (sum.topSpeedMph - 14) * 5;
  // The shape asked for: "low" means a low chassis, "long" that frame, and so on.
  if (p.chassis === "low") s += chassis.spec.sizeIn[1] <= 5.5 ? 6 : -14;
  else if (p.chassis) s += chassis.id === p.chassis ? 6 : -14;
  if (pr.armour) s += sum.armourHp / 55;
  if (pr.push) s += sum.pushRatio * 12;
  if (pr.power) s += sum.energyKJ * 0.6;
  if (pr.cheap) s -= sum.listPrice / 1200;
  if (p.invertible) s += sum.invertible ? 18 : -18;
  if (p.srimech) s += sum.selfRight !== "none" || sum.invertible ? 8 : -12;
  return s;
}

/**
 * Turn a description into a legal, buildable design: start from proven
 * layouts in the field with the asked-for weapon, then improve slot by slot,
 * keeping only changes that win more trial fights or fit the brief better.
 */
function designFromBrief(reg, { brief, career = null, design: current = null, budget = null }) {
  const p = parseBrief(brief);
  const g = career ? garageOf(reg, career) : null;
  const start = current || (g ? { name: g.name, body: g.body, build: g.build, livery: g.livery, personality: g.personality } : defToDesign(reg.robot(reg.playerId)));
  const cap = budget ?? p.budget ?? (career ? Math.max(0, career.cash) : Infinity);
  const field = sample(leagueField(reg, career), 8, `brief:${brief}`);

  if (!p.weapon && !p.template && !Object.values(p.priorities).some(Boolean) && !p.invertible) {
    return {
      kind: "design", title: "Tell me what you want to build",
      summary: "Describe the robot in a sentence and I will turn it into a legal part list.",
      points: [
        "Name a weapon: horizontal bar, undercutter, vertical disc, drum, hammer, flipper, lifter, crusher - or a wedge.",
        "Add a shape or a priority: low, round, invertible, fast, heavily armoured, strong pusher, cheap.",
        'A budget works too: "a fast drum under $12,000".',
      ],
    };
  }

  // What the design must cost (beyond parts already owned) and be allowed.
  const affordable = (d) => {
    if (!career) return { ok: true, cost: 0 };
    const q = quote(reg, career, d.build);
    return { ok: !q.locked.length && q.total <= cap, cost: q.total };
  };
  const shape = (d) => {
    const out = clone(d);
    if (p.template) out.body = { ...out.body, template: p.template };
    if (p.extras.length) out.body = { ...out.body, extras: uniqExtras([...(out.body.extras || []), ...p.extras.map((type) => ({ type }))]) };
    if (p.weapon?.mount) out.body = { ...out.body, mount: p.weapon.mount };
    out.body = fitBody(reg, out.body, out.build);
    return out;
  };
  const salt = `brief:${brief}`;
  const evalDesign = (d) => {
    const def = myDef(reg, career, d);
    let sum;
    try { sum = summarize(reg, def); } catch { return null; }
    if (!sum.legal) return null;
    const buy = affordable(d);
    if (!buy.ok) return null;
    if (p.weapon && sum.weaponClass !== p.weapon.cls) return null;
    if (p.weapon?.part && d.build.weapon !== p.weapon.part) return null;
    const g8 = gauntlet(reg, def, field, { seeds: 2, salt });
    return { design: d, sum, cost: buy.cost, win: g8.winRate, score: g8.winRate * 100 + briefScore(sum, p, reg.part(d.build.chassis)) };
  };

  // Seeds: the proven layouts in the field with this weapon, and the
  // player's own robot with the weapon swapped in.
  const seeds = [];
  const want = p.weapon?.cls;
  for (const r of reg.roster()) {
    if (r.partner || r.id === reg.playerId) continue;
    const cls = weaponClassOf(reg, r.build);
    if (want && cls !== want) continue;
    if (p.weapon?.part && r.build.weapon !== p.weapon.part) continue;
    if (Object.values(r.build).flat().some((id) => reg.hasPart(id) && reg.part(id).spec.minibot)) continue;
    seeds.push(shape({ ...start, build: clone(r.build), body: clone(r.body) || {} }));
  }
  if (want && weaponClassOf(reg, start.build) !== want) {
    const part = p.weapon.part || partsFor(reg, "weapon").filter((x) => x.spec.class === want).sort((a, b) => a.cost - b.cost)[0]?.id;
    if (part) {
      let b = setSlot(reg, start.build, "weapon", part);
      if (reg.part(part).spec.powered && !b.weaponMotor) b = setSlot(reg, b, "weaponMotor", "wmotor_mid");
      seeds.push(shape({ ...start, build: b }));
    }
  } else seeds.push(shape(start));
  if (p.chassis) {
    for (const s of [...seeds]) {
      const ids = p.chassis === "low" ? ["chassis_low_wedge", "chassis_slab_ti"] : [p.chassis];
      for (const id of ids) seeds.push(shape({ ...s, build: setSlot(reg, s.build, "chassis", id) }));
    }
  }

  // Score the seeds, then climb from the best few.
  const scored = seeds.map((d) => tryRepair(reg, d, evalDesign)).filter(Boolean).sort((a, b) => b.score - a.score);
  if (!scored.length) {
    return {
      kind: "design", title: "I could not make that work",
      summary: `Nothing with ${p.weapon ? `a ${CLASS_NAME(p.weapon.cls)}` : "that layout"} fits the weight limit${isFinite(cap) ? ` and ${money(cap)}` : ""}${career ? " with the parts you can buy now" : ""}.`,
      points: [career && cap < 3000 ? "Your budget is the problem: win some purses, or sell spare parts." : "Try a lighter weapon, or drop a requirement."],
    };
  }
  let best = scored[0];
  for (const s of scored.slice(0, 2)) {
    const climbed = climb(reg, s, evalDesign, 2);
    if (climbed.score > best.score) best = climbed;
  }
  const final = { ...best.design, name: p.name || best.design.name };
  const finalSum = summarize(reg, myDef(reg, career, final));
  const now = gauntlet(reg, myDef(reg, career, start), field, { seeds: 4, salt: "report" });
  const then = gauntlet(reg, myDef(reg, career, final), field, { seeds: 4, salt: "report" });

  const points = [
    `${finalSum.weaponName} on ${reg.part(final.build.chassis).name}: ${finalSum.weightLb} lb, ${finalSum.topSpeedMph} mph, push ${finalSum.pushRatio}x, ${finalSum.armourHp} hp of armour${finalSum.energyKJ ? `, ${finalSum.energyKJ} kJ` : ""}.`,
    finalSum.invertible ? "Runs upside down." : finalSum.selfRight !== "none" ? `Rights itself (${finalSum.selfRight}).` : "Cannot right itself - a flip ends the fight.",
    ...whyClass(reg, finalSum.weaponClass),
    `Trial fights against ${field.length} ${career ? "robots in your league" : "Rookie robots"}: ${pct(then.winRate)} (your current robot: ${pct(now.winRate)}).`,
  ];
  if (career) points.push(best.cost ? `New parts: ${money(best.cost)} (you have ${money(career.cash)}).` : "You own every part already.");
  // Say so when the shop held back what was asked for.
  if (career && p.priorities.speed && finalSum.topSpeedMph < 15) {
    const faster = [...partsFor(reg, "motor"), ...partsFor(reg, "wheel"), ...partsFor(reg, "drive")].find((x) => !canBuy(reg, career, x.id).ok);
    if (faster) points.push(`For more speed you need better drive parts (motors, wheels, drivetrain): the faster ones are tier ${faster.tier} and unlock as you move up the leagues.`);
  }
  // Say so when the shop could not supply the shape that was asked for.
  if (career && p.chassis) {
    const fits = p.chassis === "low" ? (c) => c.spec.sizeIn[1] <= 5.5 : (c) => c.id === p.chassis;
    if (!fits(reg.part(final.build.chassis))) {
      const want = partsFor(reg, "chassis").filter(fits).sort((a, b) => a.tier - b.tier)[0];
      const why = want && canBuy(reg, career, want.id);
      if (want && !why.ok) points.push(`The chassis you described (${want.name}) is not for sale to you yet: ${why.reason}`);
    }
  }
  for (const w of finalSum.warnings.slice(0, 2)) points.push(`Note: ${w}`);
  return {
    kind: "design", title: p.name ? `"${final.name}"` : `A ${CLASS_NAME(finalSum.weaponClass)} build`,
    summary: `Here is a legal design for "${String(brief).trim()}".`,
    points, design: final, evidence: { winRate: then.winRate, baseline: now.winRate, fights: then.n, cost: best.cost },
  };
}

/** A seed may come in overweight or illegal once reshaped; try a few cheap fixes. */
function tryRepair(reg, d, evalDesign) {
  const r = evalDesign(d);
  if (r) return r;
  // Drop optional extras, then lighter armour panels, until it fits.
  let x = clone(d);
  for (let i = 0; i < 6; i++) {
    const heavy = (x.build.armor || []).map((id) => reg.part(id)).sort((a, b) => b.weight - a.weight)[0];
    if (!heavy) break;
    const lighter = partsFor(reg, "armor", heavy.spec.slot).filter((q) => q.weight < heavy.weight).sort((a, b) => b.weight - a.weight)[0];
    const idx = x.build.armor.indexOf(heavy.id);
    x.build.armor = lighter ? x.build.armor.map((id, j) => (j === idx ? lighter.id : id)) : x.build.armor.filter((_, j) => j !== idx);
    const t = evalDesign(x);
    if (t) return t;
  }
  return null;
}

/** Greedy improvement, one slot at a time, for `rounds` passes. */
function climb(reg, start, evalDesign, rounds) {
  let best = start;
  for (let r = 0; r < rounds; r++) {
    let improved = false;
    for (const slot of slotsOf(reg, best.design.build)) {
      if (slot.key === "weapon") continue;   // the weapon is what was asked for
      const pool = partsFor(reg, slot.category, slot.face);
      const options = [...pool.map((q) => q.id), ...(slot.optional ? [null] : [])];
      for (const id of options) {
        if (id === slot.partId) continue;
        const build = setSlot(reg, best.design.build, slot.key, id);
        const d = { ...best.design, build, body: fitBody(reg, best.design.body, build) };
        const t = evalDesign(d);
        if (t && t.score > best.score + 0.5) { best = t; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

function whyClass(reg, cls) {
  const m = reg.matchups;
  if (!m?.vs?.[cls]) return [];
  const vs = Object.entries(m.vs[cls]);
  const good = vs.filter(([, v]) => v >= 0.58).sort((a, b) => b[1] - a[1]).map(([c]) => CLASS_NAME(c));
  const bad = vs.filter(([, v]) => v <= 0.42).sort((a, b) => a[1] - b[1]).map(([c]) => CLASS_NAME(c));
  const out = [];
  if (good.length) out.push(`In physics testing ${CLASS_NAME(cls)}s do best against: ${good.slice(0, 3).join(", ")}.`);
  if (bad.length) out.push(`They struggle against: ${bad.slice(0, 3).join(", ")}.`);
  return out;
}

// ---------------------------------------------------------------- tailor for an opponent

/**
 * Changes aimed at one opponent, each tested: the armour where its weapon
 * lands, a way back from a flip, forks or a plow against a horizontal bar, a
 * different driving style. Combinations of the best are tested too.
 */
function tailorForOpponent(reg, { career, design = null, oppId }) {
  const g = garageOf(reg, career);
  const base = design || { name: g.name, body: g.body, build: g.build, livery: g.livery, personality: g.personality };
  const opp = fieldedDef(reg, career, oppId);
  const oppSum = summarize(reg, opp);
  const mine = summarize(reg, myDef(reg, career, base));
  const salt = `opp:${oppId}:${career.seasonIndex}`;
  const SEEDS = MATCH_SEEDS;
  // Both robots as they will turn up: the damage they carry is part of the fight.
  // A changed design carries the damage only of the parts it keeps (new ones are fresh).
  const test = (d) => {
    const mine = carryCondition(reg, garageOf(reg, career), d.build).condition;
    const cond = { [career.playerId]: Object.keys(mine).length ? [mine] : null, [oppId]: wearOf(reg, career, oppId) };
    return gauntlet(reg, myDef(reg, career, d), [opp], { seeds: SEEDS, salt, cond }).winRate;
  };
  const baseWin = test(base);
  const ideas = [];
  const add = (label, d, notes) => {
    const def = myDef(reg, career, d);
    let sum;
    try { sum = summarize(reg, def); } catch { return; }
    if (!sum.legal) return;
    const q = quote(reg, career, d.build);
    if (q.locked.length) return;
    ideas.push({ label, design: d, notes, cost: q.total, win: test(d) });
  };

  // 1. Armour where its weapon lands, paid for by the faces it rarely hits.
  for (const face of THREAT_FACES[oppSum.weaponClass] || ["front"]) {
    const d = reinforce(reg, base, face, THREAT_FACES[oppSum.weaponClass]);
    if (d) add(`Heavier ${face} armour`, d, `${opp.name}'s ${CLASS_NAME(oppSum.weaponClass)} mostly hits the ${face}.`);
  }
  // 2. A way back from a flip, against something that turns robots over.
  if (FLIPPERS.has(oppSum.weaponClass) && !mine.invertible && mine.selfRight === "none") {
    for (const id of ["srimech_arm", "srimech_pneumatic"]) {
      const d = fitWithin(reg, { ...base, build: setSlot(reg, base.build, "srimech", id) }, ["top", "rear"]);
      if (d) add(`Fit a ${reg.part(id).name}`, d, `${CLASS_NAME(oppSum.weaponClass)}s win by flipping - and you cannot get back over.`);
    }
  }
  // 3. Forks or a plow: a horizontal bar glances off a wedge.
  if (oppSum.weaponClass === "spinner_h") {
    for (const type of ["forks", "plow"]) {
      if ((base.body.extras || []).some((e) => e.type === type)) continue;
      const d = { ...base, body: fitBody(reg, { ...base.body, extras: [...(base.body.extras || []), { type }] }, base.build) };
      add(`Add ${type === "plow" ? "a plow" : "forks"}`, d, "A horizontal bar that hits a wedge rides up it and loses most of its hit.");
    }
  }
  // 4. Out-drive a slow, heavy-hitting opponent; out-push a pusher.
  if (["hammer", "crusher", "spinner_h"].includes(oppSum.weaponClass) || oppSum.pushRatio > mine.pushRatio) {
    for (const id of partsFor(reg, "motor").map((m) => m.id)) {
      if (id === base.build.motor) continue;
      const d = fitWithin(reg, { ...base, build: setSlot(reg, base.build, "motor", id) }, ["rear", "top", "side"]);
      if (d) add(`Drive motors: ${reg.part(id).name}`, d, oppSum.pushRatio > mine.pushRatio ? "It out-pushes you now." : "Speed keeps you out of its reach.");
    }
  }
  // 5. Driving style (no parts): who should press, who should wait.
  for (const style of ["aggressive", "defensive", "opportunistic"]) {
    if (style === base.personality) continue;
    add(`Drive ${style === "opportunistic" ? "opportunistically" : style + "ly"}`, { ...base, personality: style }, styleNote(style, oppSum.weaponClass));
  }

  // The best two together, if they are compatible.
  const good = ideas.filter((i) => i.win > baseWin + 0.025).sort((a, b) => b.win - a.win);
  if (good.length >= 2) {
    const combo = mergeDesigns(reg, base, good[0].design, good[1].design);
    if (combo) add(`${good[0].label} + ${good[1].label.toLowerCase()}`, combo, "The two best changes together.");
  }
  const ranked = ideas.filter((i) => i.win > baseWin + 0.025).sort((a, b) => b.win - a.win || a.cost - b.cost).slice(0, 4);
  const sc = scouting(reg, opp);
  const points = [
    `${opp.name}: ${sc.weapon} (${CLASS_NAME(oppSum.weaponClass)}), ${oppSum.topSpeedMph} mph, push ${oppSum.pushRatio}x, ${oppSum.armourHp} hp of armour.`,
    `Your robot as it stands wins ${pct(baseWin)} of ${SEEDS} trial fights against it.`,
    ...matchupLine(reg, mine.weaponClass, oppSum.weaponClass),
  ];
  if (!ranked.length) points.push("Nothing I tried does clearly better - your current build is a fair answer to it.");
  return {
    kind: "opponent", title: `Against ${opp.name}`,
    summary: ranked.length ? `${ranked.length} change${ranked.length > 1 ? "s" : ""} that win more often, each tested in ${SEEDS} trial fights.` : "Your robot is already a fair answer.",
    points,
    options: ranked.map((i) => ({ label: i.label, design: i.design, winRate: i.win, delta: i.win - baseWin, cost: i.cost, notes: i.notes })),
    evidence: { baseline: baseWin, fights: SEEDS },
  };
}



/** Two tweaks of the same base, together: take every slot either one changed. */
function mergeDesigns(reg, base, a, b) {
  const build = clone(a.build);
  for (const k of Object.keys({ ...base.build, ...b.build })) {
    if (k === "armor") continue;
    if (JSON.stringify(b.build[k]) !== JSON.stringify(base.build[k])) build[k] = b.build[k];
  }
  const sb = slotsOf(reg, b.build), s0 = slotsOf(reg, base.build);
  let out = build;
  for (const s of sb) {
    const was = s0.find((x) => x.key === s.key)?.partId ?? null;
    if (s.category === "armor" && s.partId !== was) out = setSlot(reg, out, s.key, s.partId);
  }
  const extras = uniqExtras([...(a.body.extras || []), ...(b.body.extras || [])]);
  const d = { ...base, build: out, body: fitBody(reg, { ...a.body, extras }, out),
    personality: b.personality !== base.personality ? b.personality : a.personality };
  return fitWithin(reg, d, ["rear", "top", "side"]);
}

// ---------------------------------------------------------------- fight plan

/** A game plan for one fight, from the matchup and both robots' numbers. */
function fightPlan(reg, { career, design = null, oppId }) {
  const g = garageOf(reg, career);
  const base = design || { name: g.name, body: g.body, build: g.build, livery: g.livery, personality: g.personality };
  const meDef = myDef(reg, career, base);
  const opp = fieldedDef(reg, career, oppId);
  const me = summarize(reg, meDef), them = summarize(reg, opp);
  const sc = scouting(reg, opp);
  // The same trial fights the opponent advice uses, so the two never disagree.
  const salt = `opp:${oppId}:${career.seasonIndex}`;
  const cond = { [career.playerId]: wearOf(reg, career, career.playerId), [oppId]: wearOf(reg, career, oppId) };
  const styles = ["aggressive", "opportunistic", "defensive"].map((style) => ({
    style, win: gauntlet(reg, { ...meDef, personality: style }, [opp], { seeds: MATCH_SEEDS, salt, cond }).winRate,
  })).sort((a, b) => b.win - a.win);
  const bestStyle = styles[0];
  const current = styles.find((s) => s.style === base.personality) || styles[0];

  const pts = [];
  pts.push(...matchupLine(reg, me.weaponClass, them.weaponClass));
  // Their weapon.
  if (["spinner_h", "spinner_v", "drum"].includes(them.weaponClass)) {
    pts.push(`Their ${CLASS_NAME(them.weaponClass)} stores ${them.energyKJ} kJ and needs ${them.spinUpS ?? "?"} s to spin back up: hit them in the opening seconds or straight after they land one.`);
    if (them.weaponClass === "spinner_h") pts.push("A horizontal bar hits your sides and front - never give it a side. Come at it nose-first, and a wedge or forks make its hits glance.");
    else pts.push(`A ${CLASS_NAME(them.weaponClass)} only hits what is in front of it: get round to its side or back.`);
  } else if (them.weaponClass === "hammer") pts.push("A hammer has to line you up and reload after every swing: keep moving, and go in right after it fires.");
  else if (them.weaponClass === "crusher") pts.push("Do not let the jaw close on you - once it has you it holds and bites again. Stay out of its front.");
  else if (FLIPPERS.has(them.weaponClass)) pts.push(`It wins by getting under you and turning you over: never give it your nose square-on${me.invertible || me.selfRight !== "none" ? "" : ", and you cannot right yourself, so one flip ends it"}.`);
  else if (them.weaponClass === "static") pts.push("A wedge cannot hurt you much - it wants you in the hazards or stranded on top of it. Keep off the walls and the screws.");
  // Damage either side is carrying in (Stage 7): their pit did not fix everything.
  const oppA = assembleRobot(reg, opp);
  Object.assign(oppA.condition, wearOf(reg, career, oppId)?.[0] || {});
  const hurt = oppA.fittings.filter((f) => (oppA.condition[f.key] ?? 1) < 0.7)
    .sort((x, y) => oppA.condition[x.key] - oppA.condition[y.key]).slice(0, 3);
  if (hurt.length) {
    const parts = hurt.map((f) => `${f.part.name} at ${Math.round(oppA.condition[f.key] * 100)}%`).join(", ");
    const face = hurt.find((f) => f.part.category === "armor");
    pts.push(`It comes in damaged from its last fight: ${parts}.${face ? ` Go for its ${face.part.spec.slot} - that panel will not take much more.` : ""}${hurt.some((f) => ["drive", "motor", "wheel"].includes(f.part.category)) ? " Its drive is hurt: out-push it." : ""}`);
  }
  const mineA = assembleRobot(reg, meDef);
  Object.assign(mineA.condition, wearOf(reg, career, career.playerId)?.[0] || {});
  const myHurt = mineA.fittings.filter((f) => (mineA.condition[f.key] ?? 1) < 0.6).map((f) => f.part.name);
  if (myHurt.length) pts.push(`You are carrying damage yourself (${myHurt.slice(0, 3).join(", ")}): protect it, or fix it in the pit first.`);
  // Their weak points, from the scouting card.
  for (const w of sc.weak.slice(0, 3)) pts.push(`Weak point: ${w}`);
  // Speed and push.
  if (me.topSpeedMph > them.topSpeedMph + 1.5) pts.push(`You are faster (${me.topSpeedMph} vs ${them.topSpeedMph} mph): pick your moments and take their flanks.`);
  else if (them.topSpeedMph > me.topSpeedMph + 1.5) pts.push(`They are faster (${them.topSpeedMph} vs ${me.topSpeedMph} mph): do not chase - make them come to your weapon.`);
  if (me.pushRatio > them.pushRatio + 0.1) pts.push(`You out-push them (${me.pushRatio}x vs ${them.pushRatio}x): shove them into the walls and hazards for control points.`);
  else if (them.pushRatio > me.pushRatio + 0.1) pts.push(`They out-push you (${them.pushRatio}x vs ${me.pushRatio}x): stay out of shoving matches near the hazards.`);
  // Can we finish it with a flip?
  if (FLIPPERS.has(me.weaponClass) && !them.invertible && them.selfRight === "none") pts.push("It cannot right itself: one good flip wins the fight.");
  const pb = PLAYBOOK[me.weaponClass === "static" ? "wedge" : me.weaponClass];
  if (pb?.herdBias >= 0.8) pts.push("Your weapon does its best work with the arena's help: herd them toward the pulverizers and screws.");

  return {
    kind: "fight", title: `Game plan: ${opp.name}`,
    summary: `Trial fights give you ${pct(current.win)} driving ${current.style}${bestStyle.style !== current.style && bestStyle.win > current.win + 0.04 ? `; ${pct(bestStyle.win)} driving ${bestStyle.style}` : ""}.`,
    points: pts,
    evidence: { styles, fights: MATCH_SEEDS },
    options: bestStyle.style !== current.style && bestStyle.win > current.win + 0.04
      ? [{ label: `Set your AI driver to ${bestStyle.style}`, design: { ...base, personality: bestStyle.style }, winRate: bestStyle.win, delta: bestStyle.win - current.win, cost: 0, notes: "Used when your AI driver fights for you, and when you hand it the controls (Tab) in the arena." }]
      : [],
  };
}

// ---------------------------------------------------------------- season plan

/**
 * Where the season stands, what the league is made of, and the best value
 * upgrades for the money: every affordable one-part change is tested against
 * the whole league and ranked by win rate gained per dollar.
 */
function seasonPlan(reg, { career, design = null }) {
  const g = garageOf(reg, career);
  const base = design || { name: g.name, body: g.body, build: g.build, livery: g.livery, personality: g.personality };
  const lg = playerLeague(career);
  const field = leagueField(reg, career);
  const meDef = myDef(reg, career, base);
  const me = summarize(reg, meDef);
  const salt = `season:${career.seasonIndex}`;
  const now = gauntlet(reg, meDef, field, { seeds: 2, salt });

  // League make-up.
  const mix = {};
  for (const o of field) { const c = weaponClassOf(reg, o.build); mix[c] = (mix[c] || 0) + 1; }
  const mixText = Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${CLASS_NAME(c)}${n > 1 ? "s" : ""}`).join(", ");
  const worst = now.byOpp.filter((o) => o.wins === 0).slice(0, 4).map((o) => o.name);

  // Money: what a fight costs to fix, roughly, and how many that buys.
  const econ = reg.economy.league[lg];
  const reserve = Math.round((econ.appearance + econ.win) * 2.5);
  const spend = Math.max(0, career.cash - reserve);

  // Upgrades: every one-slot change the shop sells, tested on a sample.
  const sampleField = sample(field, 10, salt);
  const baseWin = gauntlet(reg, meDef, sampleField, { seeds: 2, salt: `${salt}:u` }).winRate;
  const ups = [];
  for (const slot of slotsOf(reg, base.build)) {
    let pool = partsFor(reg, slot.category, slot.face);
    if (slot.key === "weapon") pool = pool.filter((q) => base.build.weapon && q.spec.class === weaponClassOf(reg, base.build));
    for (const part of pool) {
      if (part.id === slot.partId || !canBuy(reg, career, part.id).ok) continue;
      const build = setSlot(reg, base.build, slot.key, part.id);
      const d = fitWithin(reg, { ...base, build, body: fitBody(reg, base.body, build) }, ["rear", "top", "side"]);
      if (!d) continue;
      const q = quote(reg, career, d.build);
      if (q.total > spend || q.total <= 0) continue;
      const win = gauntlet(reg, myDef(reg, career, d), sampleField, { seeds: 2, salt: `${salt}:u` }).winRate;
      if (win > baseWin + 0.03) ups.push({ label: `${slot.label}: ${part.name}`, design: d, winRate: win, delta: win - baseWin, cost: q.total, notes: "" });
    }
  }
  ups.sort((a, b) => b.delta / b.cost - a.delta / a.cost);

  const points = [
    `${LEAGUE_NAME(lg)} league, ${mixText}.`,
    `Your robot wins ${pct(now.winRate)} of ${now.n} trial fights across the league.${worst.length ? ` Hardest: ${worst.join(", ")}.` : ""}`,
    `You have ${money(career.cash)}. Keep about ${money(reserve)} back for repairs; that leaves ${money(spend)} to spend.`,
  ];
  const finalsCut = reg.league?.league?.finals?.perGroup ?? 2;
  points.push(`To go up: finish in the top ${finalsCut} of your group of five to reach the 16-robot finals, then reach the last four.`);
  const bestClass = classAdvice(reg, mix);
  if (bestClass) points.push(bestClass);
  if (!ups.length) points.push(spend < 1000 ? "Nothing worth buying fits the budget yet: bank some purses first." : "No single part makes a clear difference right now - save for a bigger change.");
  return {
    kind: "season", title: `Season ${career.seasonIndex} plan`,
    summary: ups.length ? `${Math.min(3, ups.length)} upgrade${ups.length > 1 ? "s" : ""} that pay their way, tested against your league.` : "Where you stand this season.",
    points, options: ups.slice(0, 3), evidence: { winRate: now.winRate, fights: now.n, mix },
  };
}

/** Which weapon class the measured matchups favour against this league's mix. */
function classAdvice(reg, mix) {
  const m = reg.matchups?.vs;
  if (!m) return null;
  const total = Object.values(mix).reduce((t, n) => t + n, 0);
  const score = Object.keys(m).map((c) => {
    let s = 0, w = 0;
    for (const [d, n] of Object.entries(mix)) {
      const v = d === c ? 0.5 : m[c][d];
      if (v == null) continue;
      s += v * n; w += n;
    }
    return { c, v: w ? s / w : 0.5 };
  }).sort((a, b) => b.v - a.v);
  if (!score.length || !total) return null;
  const top = score[0];
  return `Against this league's mix, ${CLASS_NAME(top.c)}s have the best measured record (${pct(top.v)} in physics testing) - worth knowing if you are planning a rebuild.`;
}

// ---------------------------------------------------------------- bits

function matchupLine(reg, mine, theirs) {
  const v = reg.matchups?.vs?.[mine]?.[theirs];
  if (v == null || mine === theirs) return [];
  const how = Object.entries(reg.matchups.winsBy?.[mine] || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  const verdict = v >= 0.58 ? "a good matchup for you" : v <= 0.42 ? "a hard matchup for you" : "an even matchup";
  return [`In physics testing ${CLASS_NAME(mine)}s beat ${CLASS_NAME(theirs)}s ${pct(v)} of the time: ${verdict}${how ? ` (they mostly win by ${howName(how)})` : ""}.`];
}
const howName = (h) => ({ "ko:disabled": "breaking the opponent", "ko:flipped": "flipping", "ko:beached": "beaching", "ko:pitted": "the pit", decision: "the judges", tapout: "tap-outs" }[h] || h);
function styleNote(style, oppCls) {
  if (style === "aggressive") return ["spinner_h", "spinner_v", "drum"].includes(oppCls) ? "Press it before its weapon is up to speed." : "Keep it under pressure.";
  if (style === "defensive") return "Wait for its mistakes and keep your distance.";
  return "Flank it and punish openings.";
}
const LEAGUE_NAME = (lg) => ({ rookie: "Rookie", pro: "Pro", elite: "Elite", world: "World Championship" }[lg] || lg);
function defToDesign(def) {
  return { name: def.name, body: clone(def.body) || {}, build: clone(def.build), livery: clone(def.livery) || {}, personality: def.personality };
}

export { gauntlet };
