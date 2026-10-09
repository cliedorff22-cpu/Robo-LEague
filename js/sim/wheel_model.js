// wheel_model.js - the tyre and suspension maths for one wheel, as pure
// arithmetic.
//
// Deliberately separated from robot_sim.js, which does the Rapier plumbing
// (raycasts, force application). Everything that decides how the bot FEELS
// lives here, which means:
//   * it is unit-testable with no physics engine and no browser
//   * porting to Godot or Unity is a copy-paste of this file plus new plumbing
//
// Frame convention: `fwd` is along the wheel's rolling direction projected
// onto the contact plane, `lat` is perpendicular to it in that plane. Positive
// load pushes along the contact normal.

/** Default sideways grip as a fraction of forward grip, when a wheel part does
 *  not state its own. Below 1.0 because a scrubbing tyre bites less sideways
 *  than it does rolling - but not far below, or a skid-steer bot pivots like a
 *  fidget spinner: nothing stops the drive torque winding the spin up. */
export const LATERAL_GRIP_FRACTION = 0.85;

/** Rolling resistance of an undriven wheel, as a fraction of the load it
 *  carries. Covers tyre deformation and gearbox drag. Small: a freewheeling
 *  wheel should coast, not act as a brake. */
export const ROLLING_RESIST_COEFF = 0.04;

/** Below this speed, rolling resistance fades out linearly instead of
 *  flipping sign every step and buzzing the wheel. */
const ROLL_DEADBAND_MPS = 0.1;

/** Same idea for the brake: fade out near a standstill so a stopped bot does
 *  not buzz between forward and reverse braking force. */
const BRAKE_DEADBAND_MPS = 0.15;

/**
 * One wheel's contribution for one step.
 *
 * @param {object} w
 * @param {number|null} w.rayDistance   anchor-to-ground distance, or null if airborne
 * @param {number} w.wheelRadiusM
 * @param {number} w.restLength         suspension travel
 * @param {number} w.springK            N/m
 * @param {number} w.springC            N/(m/s)
 * @param {number} w.compressionRate    m/s. POSITIVE WHILE COMPRESSING, i.e. the
 *                                      contact velocity measured ALONG the
 *                                      downward ray. Passing the body's upward
 *                                      velocity here inverts the damper and
 *                                      makes the suspension pump energy in.
 * @param {number} w.vFwd               contact-point speed along `fwd`, m/s
 * @param {number} w.vLat               contact-point speed along `lat`, m/s
 * @param {number} w.grip               tyre friction coefficient
 * @param {number} w.cmd                commanded track speed, -1..1
 * @param {boolean} w.powered           is this wheel driven
 * @param {number} w.topSpeedMps
 * @param {number} w.forcePerWheelN     torque limit expressed as a force
 * @param {number} w.driveGain          N per m/s of speed error
 * @param {number} w.latGain            N per m/s of sideways scrub
 * @param {number} [w.rollingResistCoeff] rolling resistance as a fraction of load
 * @param {number} [w.lateralGripFraction] sideways grip relative to forward grip
 * @param {boolean} w.brake
 * @returns {{grounded:boolean, loadN:number, compression:number, fLong:number,
 *            fLat:number, saturated:boolean, fLongPreCircle:number, fLatPreCircle:number}}
 *          `*PreCircle` are the forces before the friction-circle scaling, kept
 *          for telemetry and so the scaling can be verified in isolation.
 */
export function computeWheelForces(w) {
  if (w.rayDistance == null) {
    return {
      grounded: false, loadN: 0, compression: 0, fLong: 0, fLat: 0,
      saturated: false, fLongPreCircle: 0, fLatPreCircle: 0,
    };
  }

  // ---- 1. suspension. The ray runs from the mount to the ground; subtracting
  // the radius gives where the wheel centre sits, and the shortfall against
  // rest length is the compression.
  const wheelCenterDist = w.rayDistance - w.wheelRadiusM;
  const compression = clamp(w.restLength - wheelCenterDist, 0, w.restLength);

  // Spring plus damper, never pulling the bot down.
  const loadN = Math.max(0, w.springK * compression + w.springC * w.compressionRate);

  if (loadN <= 0) {
    return {
      grounded: true, loadN: 0, compression, fLong: 0, fLat: 0,
      saturated: false, fLongPreCircle: 0, fLatPreCircle: 0,
    };
  }

  // ---- 2. longitudinal. A real motor pulls hard when far from its commanded
  // speed and tails off as it gets there; modelling it as a proportional chase
  // of the target track speed gives that for free, and gives engine braking at
  // zero throttle (which is how these bots actually stop).
  const targetSpeed = w.cmd * w.topSpeedMps;
  let fLong;
  if (w.powered) {
    fLong = clamp((targetSpeed - w.vFwd) * w.driveGain, -w.forcePerWheelN, w.forcePerWheelN);
  } else {
    // Rolling resistance scales with the load the wheel carries, not with how
    // fast it is going - a freewheeling wheel coasts. The deadband keeps it
    // from chattering about zero.
    const coeff = w.rollingResistCoeff ?? ROLLING_RESIST_COEFF;
    fLong = -clamp(w.vFwd / ROLL_DEADBAND_MPS, -1, 1) * coeff * loadN;
  }

  // Braking locks the wheels, so it is limited by GRIP, not by motor torque.
  // Scaling the motor-braking force instead made the brake weaker than simply
  // lifting off, because coasting already commands full motor force.
  if (w.brake) {
    fLong = -clamp(w.vFwd / BRAKE_DEADBAND_MPS, -1, 1) * w.grip * loadN;
  }

  // ---- 3. lateral: resist sideways scrub, capped at the sideways grip limit.
  const muLong = w.grip;
  const muLat = w.grip * (w.lateralGripFraction ?? LATERAL_GRIP_FRACTION);
  let fLat = clamp(-w.vLat * w.latGain, -muLat * loadN, muLat * loadN);

  // ---- 4. friction circle. Grip is a budget shared between driving and
  // cornering, so a bot at full throttle cannot also turn at full bite.
  const cap = muLong * loadN;
  fLong = clamp(fLong, -cap, cap);

  const fLongPreCircle = fLong;
  const fLatPreCircle = fLat;

  const mag = Math.hypot(fLong, fLat);
  let saturated = false;
  if (mag > cap && mag > 1e-9) {
    // Scale BOTH components by the same factor, so the tyre keeps pointing
    // where it was pointing and simply delivers less of it.
    const s = cap / mag;
    fLong *= s;
    fLat *= s;
    saturated = true;
  }

  return {
    grounded: true, loadN, compression,
    fLong, fLat, saturated,
    fLongPreCircle, fLatPreCircle,
  };
}

/**
 * Spring rate and damping sized so the suspension's preload exactly carries
 * the bot's static weight. Keeping this here means ride height is derived,
 * never guessed.
 */
export function suspensionRates({ massKg, wheelCount, restLength, preload, dampingRatio, gravity = 9.81 }) {
  const perWheelN = (massKg * gravity) / wheelCount;
  const springK = perWheelN / (restLength * preload);
  const springC = 2 * Math.sqrt(springK * (massKg / wheelCount)) * dampingRatio;
  return { perWheelN, springK, springC };
}

/**
 * Taper steering authority as the bot approaches its yaw-rate limit.
 *
 * Left unchecked, a skid-steer bot winds up to its kinematic spin limit -
 * commanded track speed divided by half the track width - which for a nimble
 * 250 lb bot is over two rotations a second. That is roughly what the hardware
 * could do, but it is almost impossible to aim, and the brief asks for
 * forgiving controls.
 *
 * So: steering INTO the current rotation loses authority near the limit, while
 * counter-steering keeps full authority. The driver can always stop a spin as
 * fast as the tyres allow, they just cannot wind one up indefinitely.
 */
export function taperSteerForYawRate(steer, yawRateRadS, maxYawRateRadS) {
  if (!(maxYawRateRadS > 0)) return steer;
  const sameDirection = steer * yawRateRadS > 0;
  if (!sameDirection) return steer;
  const ratio = Math.abs(yawRateRadS) / maxYawRateRadS;
  // Quadratic, so it stays full-authority until the limit is close.
  return steer * clamp(1 - ratio * ratio, 0, 1);
}

/** Skid steer: one throttle and one steer input become two track commands. */
export function skidSteerMix(throttle, steer) {
  return {
    left: clamp(clamp(throttle, -1, 1) + clamp(steer, -1, 1), -1, 1),
    right: clamp(clamp(throttle, -1, 1) - clamp(steer, -1, 1), -1, 1),
  };
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ---------------------------------------------------------------- layout

/** Fraction of the suspension travel compressed at rest. */
export const SUSPENSION_PRELOAD = 0.5;

/**
 * Where the four wheel mounts sit on the body, and the body's height above the
 * floor at rest - pure arithmetic from the build, so the physics, the
 * renderer and the menu's turntable preview all place wheels identically.
 * @returns {{ anchorY, restLength, clearance, spawnY, wheels: [{id, side, axle, anchor}] }}
 */
export function wheelLayout(assembled) {
  const { dims, stats } = assembled;
  const restLength = stats.suspensionTravelM;
  const clearance = Math.max(0.008, stats.groundClearanceM);
  const anchorY = -dims.heightM / 2 - clearance + restLength * SUSPENSION_PRELOAD + stats.wheelRadiusM;
  const x = stats.wheelbaseHalfM;   // axles inboard of the ends
  const z = stats.trackHalfM;       // just outboard of the side armour
  return {
    anchorY, restLength, clearance,
    // The body centre's height when it sits on its springs.
    spawnY: dims.heightM / 2 + clearance,
    wheels: [
      { id: "FL", side: "left",  axle: "front", anchor: { x: +x, y: anchorY, z: +z } },
      { id: "FR", side: "right", axle: "front", anchor: { x: +x, y: anchorY, z: -z } },
      { id: "RL", side: "left",  axle: "rear",  anchor: { x: -x, y: anchorY, z: +z } },
      { id: "RR", side: "right", axle: "rear",  anchor: { x: -x, y: anchorY, z: -z } },
    ],
  };
}

