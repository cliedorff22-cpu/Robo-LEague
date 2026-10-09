// platform.js - which build of the game this page is: the desktop one (the
// pages in the project root) or the phone one (the pages in mobile/).
//
// A mobile page sets globalThis.ROBO_MOBILE before it loads the game:
//   { base: "../",            where data/ is, from the page
//     settings: { ... } }     its own defaults (lighter graphics)
// Everything else - the logic, the robots, the rules - is shared, so the two
// builds never drift apart. The on-screen controls hand their input in
// through globalThis.ROBO_TOUCH (js/input/input.js reads it).

export const MOBILE = globalThis.ROBO_MOBILE || null;

/** Where data/ lives, relative to the page. */
export const dataDir = () => `${MOBILE?.base ?? ""}data`;
