// units.js - the single place where shop units meet simulation units.
//
// Rule for the whole codebase:
//   * JSON data files store SHOP units (pounds, inches, feet, rpm, mph) because
//     that is how builders and the rulebook talk.
//   * Simulation and rendering use SI (kilograms, meters, seconds, radians).
//   * The UI converts back to shop units on the way out.
// Nothing outside this file should contain a magic conversion constant.

export const LB_TO_KG = 0.45359237;
export const KG_TO_LB = 1 / LB_TO_KG;

export const IN_TO_M = 0.0254;
export const M_TO_IN = 1 / IN_TO_M;

export const FT_TO_M = 0.3048;
export const M_TO_FT = 1 / FT_TO_M;

export const MPS_TO_MPH = 2.2369362920544;
export const MPH_TO_MPS = 1 / MPS_TO_MPH;

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

export const RPM_TO_RADPS = (2 * Math.PI) / 60;

export const lbToKg = (lb) => lb * LB_TO_KG;
export const kgToLb = (kg) => kg * KG_TO_LB;
export const inToM = (inches) => inches * IN_TO_M;
export const mToIn = (m) => m * M_TO_IN;
export const ftToM = (ft) => ft * FT_TO_M;
export const mToFt = (m) => m * M_TO_FT;
export const mpsToMph = (mps) => mps * MPS_TO_MPH;
export const degToRad = (deg) => deg * DEG_TO_RAD;
export const radToDeg = (rad) => rad * RAD_TO_DEG;
export const rpmToRadps = (rpm) => rpm * RPM_TO_RADPS;

// Convert an [x, y, z] triple of feet into meters (arena data is in feet).
export const ft3ToM = (a) => [a[0] * FT_TO_M, a[1] * FT_TO_M, a[2] * FT_TO_M];

// Convert an [x, y, z] triple of inches into meters (part data is in inches).
export const in3ToM = (a) => [a[0] * IN_TO_M, a[1] * IN_TO_M, a[2] * IN_TO_M];

// mm:ss for the match clock.
export function formatClock(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}
