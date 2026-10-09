// field.js - the field changes over the years: drivers age and retire, teams
// retire robots and build new ones, and new teams come up through Rookie.
//
// Every AI robot has a DRIVER with a career length drawn when they start
// (`careerSpan`: most around 30 seasons, a few short, none past 60) and a
// count of seasons driven; the robot itself has a working life. Each
// off-season (career.js startNextSeason -> ageField):
//
//   - every driver gets a season older: improving early in their career,
//     at their peak in the middle, slipping in the last years;
//   - a driver at the end of their span RETIRES. Their team either puts a
//     new driver in the robot (rated lower: a rookie at the sticks), or
//     folds - the robot retires with them, and a NEW TEAM with a new robot
//     joins the Rookie league;
//   - a robot past its working life is retired by its team, who build a new
//     one (new name, new design) and keep their place;
//   - the leagues are put back to 30 each: a league short of robots promotes
//     the best of the one below; Rookie takes the new teams.
//
// New robots (`makeNewcomer`) are generated from the field's own proven
// designs - a chassis, drive and weapon that work, re-armoured and re-shaped
// - with their own name, team, paint and driver, and kept in the career
// (`career.newcomers`); a career registers them with the registry whenever it
// loads (registerCareerRobots). The data files never change.
//
// Pure logic over the career save.

import { makeRng, hashSeed } from "../core/rng.js";
import { assembleRobot } from "./build.js";
import { fitBody, fitWithin, partsFor, setSlot, weaponClassOf, uniqExtras, TEMPLATES, MOUNTS } from "./workshop.js";

/** Field tunables (league.json `field`), with defaults. */
export function fieldConfig(reg) {
  const f = reg.league?.field || {};
  return {
    driverSpan: { min: 4, mode: 30, max: 60, ...(f.driverSpan || {}) },
    robotSpan: { min: 5, mode: 12, max: 28, ...(f.robotSpan || {}) },
    foldChance: f.foldChance ?? 0.45,          // a driver retiring takes the robot with them
    // A driver's POTENTIAL - how good they can become - is their own: most are
    // decent, a few are naturals. They start well below it and learn toward
    // it over the first quarter of their career (evolution.js), then hold,
    // then slip in their last years (agingDelta).
    potential: { min: 30, mode: 62, max: 99, ...(f.potential || {}) },
    startShare: f.startShare ?? [0.5, 0.75],
    aging: { learnYears: 0.25, declineYears: 0.8, decline: 2.5, ...(f.aging || {}) },
  };
}

/** A triangular draw: most often near `mode`, never below `min` or above `max`. */
export function triangular(rng, { min, mode, max }) {
  const u = rng.next();
  const c = (mode - min) / (max - min);
  const x = u < c ? min + Math.sqrt(u * (max - min) * (mode - min)) : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  return Math.round(x);
}

// ---------------------------------------------------------------- names

const FIRST = ["Alex", "Sam", "Jordan", "Casey", "Riley", "Morgan", "Taylor", "Jamie", "Drew", "Quinn", "Avery", "Reese", "Rowan", "Kai", "Sasha",
  "Dana", "Robin", "Jesse", "Emerson", "Hayden", "Parker", "Skyler", "Logan", "Charlie", "Frankie", "Remy", "Noor", "Mika", "Ari", "Toni",
  "Marisol", "Dev", "Priya", "Tomas", "Ines", "Kenji", "Lena", "Omar", "Bea", "Hugo", "Yara", "Felix", "Zoe", "Ravi", "Mei", "Otto", "Nia", "Luca"];
const LAST = ["Reyes", "Okafor", "Lindqvist", "Nakamura", "Brennan", "Castillo", "Hargreaves", "Moreau", "Patel", "Kowalski", "Adeyemi", "Fischer",
  "Delgado", "Whitlock", "Sorensen", "Achebe", "Marchetti", "Haddad", "Kim", "Novak", "Quintero", "Abernathy", "Takahashi", "Mbeki", "Larsen",
  "Petrov", "Oyelaran", "Vance", "Iwata", "Carvalho", "Bishop", "Ferreira", "Gallagher", "Dubois", "Ortega", "Schmidt", "Sato", "Kaur", "Rossi"];
const ADJ = ["Iron", "Rust", "Static", "Molten", "Hollow", "Crimson", "Feral", "Silent", "Brutal", "Copper", "Thunder", "Savage", "Neon", "Grim",
  "Velvet", "Rabid", "Frozen", "Gravel", "Scrap", "Wicked", "Mighty", "Lucky", "Rogue", "Cobalt", "Tungsten", "Riot", "Jagged", "Furious", "Spare"];
const NOUN = ["Badger", "Anvil", "Gremlin", "Piston", "Hornet", "Wrecker", "Guillotine", "Kodiak", "Ratchet", "Cyclone", "Mantis", "Bulldozer",
  "Banshee", "Raptor", "Gauntlet", "Grinder", "Thresher", "Warthog", "Comet", "Jackal", "Sprocket", "Ironside", "Havoc", "Lockjaw", "Torque",
  "Marauder", "Specter", "Wolverine", "Monsoon", "Zealot", "Clamshell", "Brick", "Tempest", "Viper", "Ox", "Juggernaut", "Goliath", "Pinball"];
const SOLO = ["Bedlam", "Kerfuffle", "Mayhem", "Ruckus", "Tantrum", "Shrapnel", "Wreckoning", "Clatter", "Bonkers", "Haywire", "Kablooey",
  "Malarkey", "Gizmo", "Pandemonium", "Hullabaloo", "Ballyhoo", "Calamity", "Rumpus", "Fracas", "Skirmish", "Smithereens", "Kaboodle"];
const TEAM = ["Robotics", "Garage", "Works", "Fabrication", "Racing", "Machine Shop", "Engineering", "Combat Labs", "Collective", "Foundry"];
const PATTERNS = ["stripes", "band", "flames", "split", "hazard", "checker", "camo", "teeth", "chevron", "bolt", "spots", "scales", "tiger", "pixels", "bricks"];
const PALETTES = [
  ["#c0392b", "#17191d", "#f1c40f"], ["#1f6feb", "#0d1117", "#f0f6fc"], ["#2ecc71", "#111a14", "#e8f5e9"], ["#8e44ad", "#16101c", "#f39c12"],
  ["#e67e22", "#1b120a", "#ecf0f1"], ["#16a085", "#0c1615", "#f4d03f"], ["#d35400", "#212121", "#bdc3c7"], ["#2c3e50", "#ecf0f1", "#e74c3c"],
  ["#f1c40f", "#1a1a1a", "#c0392b"], ["#ff4fa3", "#14101a", "#7ee6ff"], ["#7f8c8d", "#111111", "#ff6b00"], ["#00b894", "#2d3436", "#fdcb6e"],
];

/** A driver starting out: a name, a career span and a potential. */
function newDriver(rng, cfg) {
  return { name: driverName(rng), span: triangular(rng, cfg.driverSpan), years: 0, gen: 1, potential: triangular(rng, cfg.potential) };
}
/** Where a new driver starts: a share of their potential. */
const startRating = (rng, cfg, potential) => Math.round(potential * (cfg.startShare[0] + rng.next() * (cfg.startShare[1] - cfg.startShare[0])));

export function driverName(rng) {
  return `${FIRST[Math.floor(rng.next() * FIRST.length)]} ${LAST[Math.floor(rng.next() * LAST.length)]}`;
}

function robotName(rng, taken) {
  for (let i = 0; i < 40; i++) {
    const n = rng.next() < 0.35 ? SOLO[Math.floor(rng.next() * SOLO.length)]
      : `${ADJ[Math.floor(rng.next() * ADJ.length)]} ${NOUN[Math.floor(rng.next() * NOUN.length)]}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return `Unit ${Math.floor(rng.next() * 9000 + 1000)}`;
}

// ---------------------------------------------------------------- drivers

/**
 * Everyone in the field gets a driver: a name, a career length and how far
 * into it they are (a field already racing has veterans and new faces).
 */
export function seedDrivers(reg, career) {
  const cfg = fieldConfig(reg);
  career.drivers ||= {};
  career.robotLife ||= {};
  for (const id of Object.keys(career.membership)) {
    if (id === career.playerId) continue;
    const rng = makeRng(hashSeed(`${career.seed}:driver:${id}`));
    if (!career.drivers[id]) {
      const span = triangular(rng, cfg.driverSpan);
      // The field's drivers are as good as their robot files say, with room to grow.
      const potential = Math.min(99, reg.robot(id).rating + (reg.league?.evolution?.rating?.talent ?? 12));
      career.drivers[id] = { name: driverName(rng), span, years: Math.floor(rng.next() * span * 0.9), gen: 1, potential };
    }
    if (!career.robotLife[id]) {
      const span = triangular(rng, cfg.robotSpan);
      career.robotLife[id] = { span, age: Math.floor(rng.next() * span * 0.85) };
    }
  }
}

/** A driver's rating change for a season of age: learning early, slipping late. */
export function agingDelta(reg, d) {
  const a = fieldConfig(reg).aging;
  const f = d.years / Math.max(1, d.span);
  if (f < a.learnYears) return 2;
  if (f > a.declineYears) return -a.decline * (1 + (f - a.declineYears) * 4);
  return 0;
}

// ---------------------------------------------------------------- the off-season

/**
 * Age the field, retire who is due, bring in the new, and put every league
 * back to 30. Mutates the career; returns the report lines for the results.
 */
export function ageField(reg, career, season) {
  const cfg = fieldConfig(reg);
  seedDrivers(reg, career);
  const rngTeams = makeRng(hashSeed(`${career.seed}:field:${season.index}:newteams`));
  const report = { retiredDrivers: [], newDrivers: [], retiredRobots: [], newRobots: [], promoted: [] };
  career.evolution ||= {};
  career.retired ||= [];

  for (const id of Object.keys(career.membership)) {
    if (id === career.playerId) continue;
    // Each robot's off-season draws from its own stream, so one team's news
    // never shifts another's (and a season replays exactly from the seed).
    const rng = makeRng(hashSeed(`${career.seed}:field:${season.index}:${id}`));
    const d = career.drivers[id];
    const life = career.robotLife[id];
    d.years++;
    life.age++;
    // The driver's age moves their rating (evolution.js handles results).
    const e = (career.evolution[id] ||= { version: 1, bank: 0, history: [] });
    const r0 = e.rating ?? reg.robot(id).rating;
    e.rating = Math.round(Math.max(5, Math.min(99, r0 + agingDelta(reg, d))));

    if (d.years >= d.span) {
      report.retiredDrivers.push({ id, name: d.name, years: d.years, robot: reg.robot(id).name });
      career.retired.push({ kind: "driver", season: season.index, name: d.name, years: d.years, robot: id });
      if (rng.next() < cfg.foldChance) {
        // The team folds: the robot goes with its driver.
        retireRobot(reg, career, id, season, report, "its team folded when " + d.name + " retired");
        continue;
      }
      // A new driver takes the controls.
      career.drivers[id] = { ...newDriver(rng, cfg), gen: (d.gen || 1) + 1 };
      e.rating = startRating(rng, cfg, career.drivers[id].potential);
      if (career.ai?.[id]) for (const v of Object.values(career.ai[id].vs || {})) if (v.t) for (const k of Object.keys(v.t)) v.t[k] *= 0.4;   // a new driver has to learn the robot
      report.newDrivers.push({ id, name: career.drivers[id].name, robot: reg.robot(id).name, follows: d.name });
      continue;
    }
    if (life.age >= life.span) {
      // The robot has had its day: the team builds a new one and keeps its place.
      const league = career.membership[id];
      const rating = e.rating;
      retireRobot(reg, career, id, season, report, "replaced by its team's new robot");
      // Same team, same driver (and their rating), new robot.
      const nc = makeNewcomer(reg, career, { league, team: reg.robot(id).team, driver: d, rating, rng, season });
      career.membership[nc.id] = league;
      report.newRobots.push({ id: nc.id, name: nc.name, team: nc.team, league, replaces: reg.robot(id).name, replacesId: id });
    }
  }
  rebalance(reg, career, season, rngTeams, report);
  return report;
}

function retireRobot(reg, career, id, season, report, why) {
  const def = reg.robot(id);
  report.retiredRobots.push({ id, name: def.name, why });
  career.retired.push({ kind: "robot", season: season.index, id, name: def.name, why, league: career.membership[id] });
  if (career.retired.length > 400) career.retired.splice(0, career.retired.length - 400);
  delete career.membership[id];
  // A retired robot keeps only its name (the history and the Hall of Fame
  // still mention it); everything about how it fought goes.
  for (const k of ["wear", "ai", "drivers", "robotLife", "evolution"]) delete career[k]?.[id];
  if (career.newcomers?.[id]) {
    const n = career.newcomers[id];
    career.newcomers[id] = { id, name: n.name, team: n.team, newcomer: true, retired: season.index, livery: n.livery, joined: n.joined };
    reg.addRobot(career.newcomers[id]);
  }
}

/**
 * Every league back to 30: from the top down, a league that is short takes
 * the best robots of the one below (by current rating); Rookie takes new
 * teams.
 */
function rebalance(reg, career, season, rng, report) {
  const leagues = reg.league.leagues;                       // bottom to top
  const size = (reg.league.league?.groups ?? 6) * (reg.league.league?.groupSize ?? 5);
  const count = (lg) => Object.values(career.membership).filter((x) => x === lg).length;
  for (let i = leagues.length - 1; i > 0; i--) {
    const lg = leagues[i], below = leagues[i - 1];
    while (count(lg) < size) {
      const cands = Object.entries(career.membership).filter(([id, l]) => l === below && id !== career.playerId)
        .map(([id]) => ({ id, r: career.evolution?.[id]?.rating ?? reg.robot(id).rating }))
        .sort((a, b) => b.r - a.r);
      if (!cands.length) break;
      career.membership[cands[0].id] = lg;
      report.promoted.push({ id: cands[0].id, name: reg.robot(cands[0].id).name, to: lg });
    }
  }
  const rookie = leagues[0];
  while (count(rookie) < size) {
    const nc = makeNewcomer(reg, career, { league: rookie, rng, season });
    career.membership[nc.id] = rookie;
    report.newRobots.push({ id: nc.id, name: nc.name, team: nc.team, league: rookie, newTeam: true });
  }
}

// ---------------------------------------------------------------- new robots

const WEAPON_MIX = [["spinner_v", 22], ["spinner_h", 16], ["drum", 12], ["hammer", 12], ["static", 10], ["flipper", 10], ["lifter", 9], ["crusher", 9]];

/**
 * A new robot for the field, built from a design that already works: a robot
 * of the chosen weapon class from the field, re-armoured, re-shaped and
 * repainted, with its own name, team and driver.
 */
export function makeNewcomer(reg, career, { league = "rookie", team = null, driver = null, rating = null, rng: parentRng, season }) {
  let rng = parentRng;
  career.newcomers ||= {};
  career.drivers ||= {};
  career.robotLife ||= {};
  const cfg = fieldConfig(reg);
  const n = Object.keys(career.newcomers).length + 1;
  const id = `nc${season.index}_${n}`;
  // Names are unique within this career's field (the registry may hold other careers' robots).
  const taken = new Set([...reg.roster(), ...Object.values(career.newcomers)].map((r) => r.name.toLowerCase()));
  rng = makeRng(hashSeed(`${career.seed}:newcomer:${id}:${Math.floor(rng.next() * 1e9)}`));
  // The weapon, weighted toward what the sport actually builds.
  const total = WEAPON_MIX.reduce((t, [, w]) => t + w, 0);
  let roll = rng.next() * total, cls = WEAPON_MIX[0][0];
  for (const [c, w] of WEAPON_MIX) { roll -= w; if (roll <= 0) { cls = c; break; } }
  const tier = { rookie: 1, pro: 2, elite: 3, world: 3 }[league] ?? 1;
  const ok = (r) => !r.partner && weaponClassOf(reg, r.build) === cls &&
    [...Object.values(r.build).flat()].every((pid) => !reg.hasPart(pid) || (reg.part(pid).tier ?? 1) <= tier);
  let pool = reg.roster().filter(ok);
  if (!pool.length) pool = reg.roster().filter((r) => !r.partner && weaponClassOf(reg, r.build) === cls);
  const seed = pool[Math.floor(rng.next() * pool.length)] || reg.robot(reg.playerId);
  let build = JSON.parse(JSON.stringify(seed.build));
  // Its own armour: each panel swapped for another of the same face, at random.
  build.armor = (build.armor || []).map((pid) => {
    const face = reg.part(pid).spec.slot;
    const opts = partsFor(reg, "armor", face).filter((p) => (p.tier ?? 1) <= tier);
    return opts.length && rng.next() < 0.6 ? opts[Math.floor(rng.next() * opts.length)].id : pid;
  });
  // Its own shape.
  const mounts = MOUNTS[cls] || ["front"];
  let body = { template: TEMPLATES[Math.floor(rng.next() * TEMPLATES.length)], mount: mounts[Math.floor(rng.next() * mounts.length)], extras: [] };
  if (seed.body?.mount === "shell" || seed.body?.mount === "lid" || seed.body?.mount === "overhead") body = { ...body, mount: seed.body.mount, template: seed.body.template };
  if (rng.next() < 0.3) body.extras = uniqExtras([{ type: ["forks", "plow", "spikes", "fin", "horns", "eyes", "bumper"][Math.floor(rng.next() * 7)] }]);
  body = fitBody(reg, body, build);
  let design = fitWithin(reg, { build, body }, ["rear", "top", "side"]) || { build: seed.build, body: seed.body };
  // A shape that will not build (some bodies and weapons do not mix) falls back to the seed's.
  try { assembleRobot(reg, { ...seed, id, build: design.build, body: design.body }); } catch { design = { build: seed.build, body: seed.body }; }
  const pal = PALETTES[Math.floor(rng.next() * PALETTES.length)];
  const name = robotName(rng, taken);
  const surname = (driver?.name || driverName(rng)).split(" ").pop();
  const def = {
    schema: "robot/1", id, name, number: 200 + n, origin: "newcomer", newcomer: true,
    archetype: cls === "static" ? "wedge" : cls, league,
    rating: 50,   // replaced below from the driver's potential
    personality: ["aggressive", "defensive", "opportunistic"][Math.floor(rng.next() * 3)],
    team: team || `${rng.next() < 0.5 ? surname : NOUN[Math.floor(rng.next() * NOUN.length)]} ${TEAM[Math.floor(rng.next() * TEAM.length)]}`,
    inspiredBy: null, joined: season.index,
    livery: { primary: pal[0], secondary: pal[1], accent: pal[2], pattern: PATTERNS[Math.floor(rng.next() * PATTERNS.length)] },
    body: design.body, build: design.build,
  };
  career.drivers[id] = driver ? { ...driver } : newDriver(rng, cfg);
  def.rating = rating ?? startRating(rng, cfg, career.drivers[id].potential ?? 60);
  career.newcomers[id] = def;
  reg.addRobot(def);
  career.robotLife[id] = { span: triangular(rng, cfg.robotSpan), age: 0 };
  return def;
}

/**
 * A team brings in a robot it bought (the player's, sold on the market -
 * market.js): its own robot is retired and the bought one takes its place,
 * its league and its driver. `design` is { name, body, build, livery,
 * personality, archetype, partner }. @returns the new robot def
 */
export function adoptRobot(reg, career, oldId, design, season, report, why) {
  career.newcomers ||= {};
  const league = career.membership[oldId];
  const old = reg.robot(oldId);
  const driver = career.drivers?.[oldId] ? { ...career.drivers[oldId] } : null;
  const rating = career.evolution?.[oldId]?.rating ?? old.rating;
  retireRobot(reg, career, oldId, season, report, why);
  let n = Object.keys(career.newcomers).length + 1;
  while (career.newcomers[`nc${season.index}_${n}`]) n++;
  const id = `nc${season.index}_${n}`;
  // Its name stays its own unless the field already has one like it.
  const taken = new Set([...reg.roster(), ...Object.values(career.newcomers)].filter((r) => r.id !== id).map((r) => r.name.toLowerCase()));
  const name = taken.has(design.name.toLowerCase()) ? `${design.name} II` : design.name;
  const def = {
    schema: "robot/1", id, name, number: 200 + n, origin: "newcomer", newcomer: true, formerPlayer: true,
    archetype: design.archetype, league, rating, personality: design.personality || old.personality,
    team: old.team, inspiredBy: null, joined: season.index,
    livery: design.livery || {}, body: design.body, build: design.build,
    ...(design.partner ? { partner: design.partner } : {}),
  };
  career.drivers ||= {};
  career.robotLife ||= {};
  career.drivers[id] = driver || newDriver(makeRng(hashSeed(`${career.seed}:driver:${id}`)), fieldConfig(reg));
  career.robotLife[id] = { span: triangular(makeRng(hashSeed(`${career.seed}:life:${id}`)), fieldConfig(reg).robotSpan), age: 0 };
  career.newcomers[id] = def;
  reg.addRobot(def);
  career.membership[id] = league;
  return def;
}

/** Register a career's own robots with the registry (call whenever a career is loaded). */
export function registerCareerRobots(reg, career) {
  for (const def of Object.values(career?.newcomers || {})) reg.addRobot(def);
}
