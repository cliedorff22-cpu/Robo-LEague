// catalog.js - the robot list the menus show: who is in the field, sorted and
// filtered, and a one-glance spec card per robot.
//
// Pure logic: registry in, plain objects out. The menu screens render these;
// nothing here knows about the DOM.

import { assembleRobot, assemblePartner } from "./build.js";
import { buildShape } from "./shape.js";

export const LEAGUE_ORDER = ["world", "elite", "pro", "rookie"];
export const LEAGUE_NAMES = { world: "World Championship", elite: "Elite", pro: "Pro", rookie: "Rookie", exhibition: "Exhibition" };

export const WEAPON_NAMES = {
  spinner_h: "Horizontal spinner", spinner_v: "Vertical spinner", drum: "Drum",
  hammer: "Hammer", flipper: "Flipper", lifter: "Lifter", crusher: "Crusher",
  static: "Wedge", none: "No weapon",
};
export const ARCHETYPE_NAMES = { ...WEAPON_NAMES, wedge: "Wedge", multibot: "Multibot" };

/**
 * Every robot the player can pick, A to Z. Roster bots carry their league;
 * the house and test bots outside the field are "exhibition".
 * @returns [{ id, name, league, origin, archetype, team, inspiredBy, rating, number, isPlayer, sortKey }]
 */
export function catalog(reg) {
  // Robots that joined during a career (field.js) are part of the field too.
  const inRoster = new Set([...reg.roster().map((r) => r.id), ...reg.allRobots().filter((r) => r.newcomer && !r.retired).map((r) => r.id)]);
  return reg.allRobots()
    .filter((r) => !r.retired)       // a career's retired robots are only names now
    .map((r) => ({
      id: r.id,
      name: r.name,
      league: inRoster.has(r.id) ? r.league : "exhibition",
      origin: r.origin,
      archetype: r.archetype,
      team: r.team || "",
      inspiredBy: r.inspiredBy || null,
      rating: r.rating,
      number: r.number,
      livery: r.livery || {},
      multibot: !!r.partner,
      isPlayer: r.id === reg.playerId,
      sortKey: r.name.toLowerCase(),
    }))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

/**
 * Narrow the list: `league` is a league id, "all", or "exhibition"; `query`
 * matches the name, team or archetype, case-insensitively.
 */
export function filterCatalog(entries, { league = "all", query = "" } = {}) {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (league !== "all" && e.league !== league) return false;
    if (!q) return true;
    return e.sortKey.includes(q) || e.team.toLowerCase().includes(q) ||
      (ARCHETYPE_NAMES[e.archetype] || "").toLowerCase().includes(q);
  });
}

/**
 * The spec card: what a fan wants to know before the fight, all derived from
 * the build (never stated in the robot file).
 */
export function specCard(reg, id, def = reg.robot(id)) {
  const a = assembleRobot(reg, def);
  const partner = def.partner ? assemblePartner(reg, def) : null;
  const w = a.stats.weapon;
  const shape = buildShape(a);
  const energy = w.energyJ || 0;
  return {
    id,
    name: def.name,
    team: def.team || "",
    league: LEAGUE_NAMES[reg.roster().some((r) => r.id === id) || def.newcomer ? def.league : "exhibition"],
    archetype: ARCHETYPE_NAMES[def.archetype] || def.archetype,
    inspiredBy: def.inspiredBy || null,
    origin: def.origin,
    rating: def.rating,
    personality: def.personality,
    weightLb: Math.round((a.weightLb + (partner ? partner.weightLb : 0)) * 10) / 10,
    topSpeedMph: Math.round(a.stats.topSpeedMph * 10) / 10,
    pushRatio: Math.round(a.stats.pushRatio * 100) / 100,
    weapon: a.parts.weapon ? a.parts.weapon.name : "None",
    weaponClass: WEAPON_NAMES[w.class] || w.class,
    weaponEnergyKJ: Math.round(energy / 100) / 10,
    armourHp: Math.round(a.stats.armorHp),
    invertible: shape.invertible,
    selfRights: a.stats.selfRight.via !== "none",
    partner: partner ? { name: partner.name, weapon: partner.parts.weapon?.name ?? "None" } : null,
  };
}

/**
 * A scouting card for the career's next opponent: the spec card plus what to
 * watch for and where it is weak, read off the build.
 */
export function scouting(reg, def) {
  const card = specCard(reg, def.id, def);
  const a = assembleRobot(reg, def);
  const s = a.stats, w = s.weapon;
  const shape = buildShape(a);
  const notes = [], weak = [];

  if (w.class === "spinner_h" || w.class === "spinner_v" || w.class === "drum") {
    notes.push(`Stores ${(w.energyJ / 1000).toFixed(1)} kJ and needs ${w.spinUpS.toFixed(1)} s to spin back up after a hit.`);
    weak.push("Hit it while the weapon is still spinning up.");
  } else if (w.class === "hammer") notes.push("Overhead strikes: keep moving, it has to line you up.");
  else if (w.class === "flipper" || w.class === "lifter") notes.push(`${w.class === "flipper" ? "Flips" : "Lifts"} from the front: don't give it your nose${w.charges && isFinite(w.charges) ? ` (${w.charges} shots of gas)` : ""}.`);
  else if (w.class === "crusher") notes.push("Grabs and crushes: once held, it bites again and again.");
  else if (w.class === "static") notes.push("A pusher: it wants you off your wheels or into the hazards.");

  if (!shape.invertible && s.selfRight.via === "none") weak.push("Cannot run upside down or right itself: a flip ends its fight.");
  else if (shape.invertible) notes.push("Runs upside down: flipping it does nothing.");
  else if (s.selfRight.via === "gyro") notes.push("Can sometimes right itself on its rotor's gyro kick - a flip is a scramble, not a KO.");
  else notes.push(`Rights itself with its ${s.selfRight.via === "srimech" ? "self-righting arm" : "weapon"}.`);

  const panels = a.fittings.filter((f) => f.part.category === "armor");
  const slots = new Set(panels.map((f) => f.part.spec.slot));
  for (const [slot, label] of [["side", "sides"], ["rear", "back"], ["top", "top"]]) {
    if (!slots.has(slot)) weak.push(`No armour on the ${label}.`);
  }
  if (s.topSpeedMph < 12) weak.push(`Slow (${s.topSpeedMph.toFixed(1)} mph): you can out-drive it.`);
  else if (s.topSpeedMph > 18) notes.push(`Fast (${s.topSpeedMph.toFixed(1)} mph).`);
  if (s.pushRatio < 0.8) weak.push(`Weak pusher (${s.pushRatio.toFixed(2)}x its weight).`);
  else if (s.pushRatio > 1.1) notes.push(`Strong pusher (${s.pushRatio.toFixed(2)}x): don't get into a shoving match.`);
  return { ...card, notes, weak, driver: { rating: def.rating, personality: def.personality, league: def.league } };
}
