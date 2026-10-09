// physics.js - the one and only place the physics engine is named.
//
// Every other file in js/sim imports RAPIER from here. Two reasons:
//
//  1. Portability. Swapping Rapier for another engine (or for Godot's built-in
//     physics) starts by rewriting this file and the plumbing in robot_sim.js -
//     nothing has to hunt for import statements.
//
//  2. Testability. The browser resolves "rapier" through the import map in
//     index.html, which points at jsDelivr. The headless test harness
//     (tools/headless.sh) substitutes THIS FILE ALONE for one that loads a
//     vendored copy, which is how js/sim gets real integration tests under
//     JavaScriptCore with no browser involved.
//
// Keep this file trivial. If it grows logic, the substitution above stops
// being a faithful test.

import RAPIER from "rapier";

export { RAPIER };

/** Must be awaited once before any world is built. */
export async function initPhysics() {
  await RAPIER.init();
  return RAPIER;
}
