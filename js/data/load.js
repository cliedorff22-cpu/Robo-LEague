// load.js - environment-specific fetchers that feed makeRegistry().
//
// The only files in the data layer allowed to know whether we are in a browser.

import { makeRegistry } from "./registry.js";

// Which robot files to load comes from data/robots/index.json (written by
// tools/gen_roster.py): the 120-robot roster plus the exhibition/test bots.
const robotIds = (index) => [...index.roster, ...(index.exhibition || [])];

// Browser path: fetch JSON over HTTP.
export async function loadRegistryFromFetch(base = "data") {
  const getJson = async (path) => {
    const res = await fetch(`${base}/${path}`);
    if (!res.ok) throw new Error(`failed to load ${path}: ${res.status} ${res.statusText}`);
    return res.json();
  };

  const [rules, arena, parts, index, league, economy, matchups, arenas] = await Promise.all([
    getJson("rules.json"),
    getJson("arena.json"),
    getJson("parts.json"),
    getJson("robots/index.json"),
    getJson("league.json"),
    getJson("economy.json"),
    // Measured class-vs-class physics results, for the build advisor. Optional.
    getJson("matchups.json").catch(() => null),
    // Hazard layouts and venues (js/logic/arenas.js). Optional.
    getJson("arenas.json").catch(() => null),
  ]);
  const robots = await Promise.all(robotIds(index).map((id) => getJson(`robots/${id}.json`)));

  return makeRegistry({ rules, arena, parts, robots, index, league, economy, matchups, arenas });
}

// Headless path: `readJson` is injected by the caller (the test runner passes a
// readFile-based reader). Keeps this module free of any host API.
export function loadRegistrySync(readJson, base = "data") {
  const rules = readJson(`${base}/rules.json`);
  const arena = readJson(`${base}/arena.json`);
  const parts = readJson(`${base}/parts.json`);
  const index = readJson(`${base}/robots/index.json`);
  const robots = robotIds(index).map((id) => readJson(`${base}/robots/${id}.json`));
  const league = readJson(`${base}/league.json`);
  const economy = readJson(`${base}/economy.json`);
  let matchups = null;
  try { matchups = readJson(`${base}/matchups.json`); } catch { matchups = null; }
  let arenas = null;
  try { arenas = readJson(`${base}/arenas.json`); } catch { arenas = null; }
  return makeRegistry({ rules, arena, parts, robots, index, league, economy, matchups, arenas });
}
