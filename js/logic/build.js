// build.js - assemble a robot from part ids into derived stats, and judge it
// against the rulebook.
//
// This is the heart of the data-driven design: a robot JSON file names parts,
// and everything the simulation needs (mass, inertia, top speed, tractive
// force, armour rating) is COMPUTED here from part specs. No robot file ever
// states its own top speed.
//
// Pure logic: no Three.js, no Rapier, no DOM. Runs headless.

import { lbToKg, inToM, mpsToMph, degToRad } from "../core/units.js";

const GRAVITY = 9.81;

// Armour and structure sit on the perimeter, so a battlebot's real rotational
// inertia runs above the uniform-solid-box figure. One honest fudge factor,
// named and in one place, rather than magic numbers sprinkled through physics.
const INERTIA_PERIMETER_FACTOR = 1.18;

// Single armour category can appear several times (front/side/side), so the
// loadout splits into "one part per slot" and "a list".
const SINGLE_SLOTS = ["chassis", "drive", "wheel", "motor", "battery", "electronics", "weaponMotor", "weapon", "srimech"];

/**
 * Assemble a robot definition into a full, simulation-ready description.
 * @param {object} reg      registry from makeRegistry()
 * @param {object} robotDef parsed robot/1 JSON
 */
export function assembleRobot(reg, robotDef) {
  const b = robotDef.build;
  const parts = {};

  for (const slot of SINGLE_SLOTS) {
    const id = b[slot];
    if (!id) { parts[slot] = null; continue; }
    const part = reg.part(id);
    if (part.category !== slot) {
      throw new Error(`${robotDef.id}: part "${id}" is category "${part.category}", expected "${slot}"`);
    }
    parts[slot] = part;
  }

  parts.armor = (b.armor || []).map((id) => {
    const part = reg.part(id);
    if (part.category !== "armor") {
      throw new Error(`${robotDef.id}: armour slot holds "${id}" of category "${part.category}"`);
    }
    return part;
  });

  const weightLb = totalWeightLb(parts);
  const massKg = lbToKg(weightLb);
  const dims = chassisDims(parts.chassis);
  const stats = deriveStats(parts, massKg, dims);
  const inertia = boxInertia(massKg, dims);
  const comLocalM = chassisCom(parts.chassis);

  const assembled = {
    id: robotDef.id,
    name: robotDef.name,
    number: robotDef.number,
    livery: robotDef.livery,
    archetype: robotDef.archetype,
    personality: robotDef.personality,
    def: robotDef,
    parts,
    // Fitting list drives condition, damage routing and the pit report.
    fittings: fittings(parts),
    weightLb,
    massKg,
    dims,
    comLocalM,
    inertia,
    stats,
    // Persistent part condition, 1.0 = factory fresh. Stage 2 writes damage
    // here, Stage 7 reads it in the pit. It lives on the robot, not the match,
    // precisely so it survives between fights.
    condition: freshCondition(parts),
  };

  assembled.legality = checkLegality(reg, assembled);
  return assembled;
}

/**
 * The second robot of a multibot, assembled as a robot in its own right. A
 * multibot file carries a `partner` block (name, body, build) beside its own;
 * the two share the weight limit (see checkMultibotWeight).
 */
export function assemblePartner(reg, robotDef) {
  const p = robotDef.partner;
  if (!p) return null;
  return assembleRobot(reg, {
    ...robotDef,
    id: `${robotDef.id}__${(p.name || "b").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    name: p.name || `${robotDef.name} B`,
    body: p.body,
    build: p.build,
    partner: undefined,
    unitOf: robotDef.id,
  });
}

/** A multibot's units together must make weight, like any single robot. */
export function checkMultibotWeight(reg, a, b) {
  const { cap, tolerance } = reg.rules.weightClass;
  const total = round2(a.weightLb + b.weightLb);
  return total > cap + tolerance
    ? [`Multibot overweight: ${a.weightLb} + ${b.weightLb} = ${total} lb exceeds the ${cap} lb cap.`]
    : [];
}

/**
 * Every part in the loadout as {key, part} pairs.
 *
 * `key` identifies the FITTING, not the part type: a bot with two identical
 * UHMW side panels has fittings "armor.0" and "armor.1" both pointing at
 * part "armor_uhmw_side". Condition, damage and repairs are all keyed this
 * way, because the pit has to let you repair the left panel and leave the
 * right one bent.
 */
export function fittings(parts) {
  const out = [];
  for (const slot of SINGLE_SLOTS) {
    if (parts[slot]) out.push({ key: slot, part: parts[slot] });
  }
  parts.armor.forEach((part, i) => out.push({ key: `armor.${i}`, part }));
  return out;
}

/** Just the parts, for sums that do not care which fitting they came from. */
export function partList(parts) {
  return fittings(parts).map((f) => f.part);
}

function totalWeightLb(parts) {
  return round2(fittings(parts).reduce((sum, f) => sum + f.part.weight, 0));
}

function freshCondition(parts) {
  const c = {};
  for (const f of fittings(parts)) c[f.key] = 1.0;
  return c;
}

function chassisDims(chassis) {
  const [l, h, w] = chassis.spec.sizeIn;
  return { lengthM: inToM(l), heightM: inToM(h), widthM: inToM(w) };
}

function chassisCom(chassis) {
  const [x, y, z] = chassis.spec.comLocalIn || [0, 0, 0];
  return { x: inToM(x), y: inToM(y), z: inToM(z) };
}

/** Principal inertia of a box about its centre of mass, scaled for perimeter mass. */
function boxInertia(massKg, dims) {
  const { lengthM: L, heightM: H, widthM: W } = dims;
  const k = (massKg / 12) * INERTIA_PERIMETER_FACTOR;
  return {
    x: k * (H * H + W * W),   // roll
    y: k * (L * L + W * W),   // yaw - the one skid steering fights
    z: k * (L * L + H * H),   // pitch
  };
}

/** Drivetrain and protection numbers, all computed from part specs. */
function deriveStats(parts, massKg, dims) {
  const drive = parts.drive.spec;
  const wheel = parts.wheel.spec;
  const motor = parts.motor.spec;
  const chassisClearanceIn = parts.chassis.spec.groundClearanceIn ?? 0.75;

  const wheelRadiusM = inToM(wheel.diameterIn / 2);
  const drivenWheels = Math.min(drive.wheelCount, wheel.count);

  // Free-running top speed: motor rpm through the reduction, at the rim.
  const wheelRpm = motor.maxRpm / drive.gearRatio;
  const topSpeedMps = (wheelRpm / 60) * 2 * Math.PI * wheelRadiusM;

  // Torque at one wheel, and the force that puts on the floor.
  const wheelTorqueNm = motor.maxTorqueNm * drive.gearRatio * drive.efficiency;
  const forcePerWheelN = wheelTorqueNm / wheelRadiusM;
  const tractiveForceN = forcePerWheelN * drivenWheels;

  // Real acceleration is whichever runs out first: torque or grip.
  const gripLimitN = wheel.grip * massKg * GRAVITY;
  const usableForceN = Math.min(tractiveForceN, gripLimitN);

  const armorHp = parts.armor.reduce((s, a) => s + a.hp, 0);
  const armorRating = parts.armor.reduce((s, a) => s + a.hp * a.spec.hardness, 0);

  const stats = {
    wheelRadiusM,
    wheelWidthM: inToM(wheel.widthIn),
    wheelCount: wheel.count,
    drivenWheels,
    grip: wheel.grip,
    gearRatio: drive.gearRatio,
    steering: drive.steering,

    topSpeedMps,
    topSpeedMph: mpsToMph(topSpeedMps),
    wheelTorqueNm,
    forcePerWheelN,
    tractiveForceN,
    gripLimitN,
    accelMps2: usableForceN / massKg,
    // Push-vs-weight, the number drivers actually care about in a shoving match.
    pushRatio: usableForceN / (massKg * GRAVITY),

    armorHp,
    armorRating,
    chassisHp: parts.chassis.hp,
    reliability: parts.electronics.spec.reliability,
    powerWh: parts.battery.spec.capacityWh,
    weapon: deriveWeapon(parts.weapon, parts.weaponMotor),
    selfRight: deriveSelfRight(parts),

    // Ride height is a PROPERTY OF THE CHASSIS, declared in parts.json. It
    // used to be derived as (wheelRadius - chassisHeight/2), which goes
    // negative whenever the chassis is taller than the wheel diameter - it
    // clamped to a few millimetres, less than the suspension travel, so the
    // chassis collider ground out on the floor and dragged.
    groundClearanceM: inToM(chassisClearanceIn),
    // Suspension travel is mostly tyre squish, so it is a wheel property.
    // It must stay below the ground clearance or the chassis drags - see
    // validate.js, which enforces that.
    suspensionTravelM: inToM(wheel.suspensionTravelIn ?? 0.5),
    lateralGripFraction: wheel.lateralGripFactor ?? 0.85,

    // Wheel layout, derived here so the physics and these figures cannot
    // disagree. robot_sim places its wheel mounts from exactly these.
    trackHalfM: dims.widthM / 2 + inToM(wheel.widthIn) * 0.45,
    wheelbaseHalfM: dims.lengthM * 0.30,
    maxYawRateRadS: degToRad(drive.maxYawRateDegS ?? 420),
  };

  // Can this build actually turn?
  //
  // Pivoting a skid-steer bot pits the drive torque about the yaw axis against
  // the lateral grip of every wheel resisting the scrub. If the drive loses,
  // the bot simply will not rotate - which is exactly what a 2WD build with
  // weak motors and grippy tyres does. Surfacing it as a number lets the
  // workshop warn the player instead of letting them discover it in a match.
  const pivotDriveTorqueNm = stats.drivenWheels * stats.forcePerWheelN * stats.trackHalfM;
  const pivotResistTorqueNm =
    stats.grip * stats.lateralGripFraction * massKg * GRAVITY * stats.wheelbaseHalfM;
  stats.pivotDriveTorqueNm = pivotDriveTorqueNm;
  stats.pivotResistTorqueNm = pivotResistTorqueNm;
  stats.pivotAuthority = pivotResistTorqueNm > 0
    ? pivotDriveTorqueNm / pivotResistTorqueNm
    : Infinity;

  return stats;
}

/**
 * What a weapon actually does, derived from its physical spec.
 *
 * Nothing here is stated in the data: a spinner's energy comes from its rotor
 * inertia and tip speed, and how long it takes to reach that energy comes from
 * the weapon motor's power. Fit a bigger motor and the same bar spools faster;
 * fit a heavier rotor and it hits harder but takes longer to get going. That
 * trade is the whole point of the weapon slot.
 */
export function deriveWeapon(weapon, weaponMotor) {
  if (!weapon) {
    return { class: "none", powered: false, energyJ: 0, concentration: 0, spinUpS: 0 };
  }
  const w = weapon.spec;
  const out = {
    class: w.class,
    powered: !!w.powered,
    concentration: w.concentration ?? 1.0,
    selfDamageFraction: w.selfDamageFraction ?? 0.1,
    gyroEffect: w.gyroEffect ?? 0,
    energyJ: 0,
    tipSpeedMps: 0,
    maxOmegaRadS: 0,
    rotorInertiaKgM2: w.rotorInertiaKgM2 ?? 0,
    spinUpS: 0,
    spinDownS: 0,
    cycleS: w.cycleS ?? 0,
    charges: w.charges ?? Infinity,
    impulseNs: w.impulseNs ?? 0,
  };

  if (w.class === "spinner_h" || w.class === "spinner_v" || w.class === "drum") {
    // Kinetic store: E = 1/2 I omega^2, with omega set by tip speed at the rim.
    const radiusM = inToM(w.radiusIn);
    const omega = radiusM > 0 ? w.maxTipSpeedMps / radiusM : 0;
    out.maxOmegaRadS = omega;
    out.tipSpeedMps = w.maxTipSpeedMps;
    out.energyJ = 0.5 * w.rotorInertiaKgM2 * omega * omega;
    out.radiusM = radiusM;

    // Spin-up is energy divided by the power the motor can actually put in.
    // No weapon motor means it never spins at all.
    const powerW = weaponMotor ? weaponMotor.spec.powerW * weaponMotor.spec.efficiency : 0;
    out.motorPowerW = powerW;
    out.spinUpS = powerW > 0 ? out.energyJ / powerW : Infinity;
    // Coasting down takes longer than spinning up - there is nothing braking it.
    out.spinDownS = out.spinUpS * 2.2;
  } else if (w.class === "hammer" || w.class === "flipper" || w.class === "lifter") {
    // Discrete strike: the energy is whatever the actuator delivers per swing.
    out.energyJ = w.impactEnergyJ ?? 0;
    out.reachM = inToM(w.reachIn ?? 0);
    out.spinUpS = 0;
  } else if (w.class === "crusher") {
    // A crusher does not throw energy, it applies force over a stroke. The
    // energy per bite is the honest work done: force x stroke.
    const strokeM = inToM(w.strokeIn ?? 1.0);
    out.energyJ = (w.crushForceN ?? 0) * strokeM;
    out.crushForceN = w.crushForceN ?? 0;
    // How far ahead of the nose the jaw takes hold - the AI closes it as the
    // opponent comes into this, not once it is already touching.
    out.reachM = inToM(w.reachIn ?? 18) * 0.45;
    out.strokeM = strokeM;
    out.biteIntervalS = w.biteIntervalS ?? 0.7;
    out.spinUpS = 0;
  } else {
    // Static: no stored energy. It damages only through ram energy.
    out.energyJ = 0;
  }

  return out;
}

/**
 * Can this robot get itself back onto its wheels once flipped, and how hard
 * does it push? A dedicated self-righting mechanism if one is fitted;
 * otherwise a flipper, hammer or lifter can push off the floor with its
 * weapon, as they do on the show. Spinners, drums, crushers and wedges cannot -
 * for them a flip is the end, unless the body can run inverted (shape.js).
 */
export function deriveSelfRight(parts) {
  if (parts.srimech) {
    return { via: "srimech", impulseNs: parts.srimech.spec.impulseNs ?? 420, cooldownS: parts.srimech.spec.cooldownS ?? 2.5, fitting: "srimech" };
  }
  const w = parts.weapon?.spec;
  if (w && (w.class === "flipper" || w.class === "hammer" || w.class === "lifter" || w.class === "crusher")) {
    const impulse = w.class === "flipper" ? Math.min(560, (w.impulseNs ?? 600) * 0.6)
      : w.class === "hammer" ? 460 : w.class === "crusher" ? 380 : 400;
    return { via: "weapon", impulseNs: impulse, cooldownS: Math.max(1.2, w.cycleS ?? 2), fitting: "weapon" };
  }
  // A vertical disc or drum can throw itself back over on its rotor's
  // gyroscopic kick - the "gyro dance" - but it is a scramble, not a sure
  // thing: it works about half the time and needs a breather between tries.
  if (w && w.powered && (w.class === "spinner_v" || w.class === "drum")) {
    return { via: "gyro", impulseNs: 380, cooldownS: 3.5, chance: 0.55, fitting: "weapon" };
  }
  return { via: "none", impulseNs: 0, cooldownS: 0, fitting: null };
}

/**
 * Rulebook check. `errors` make a build illegal (cannot fight); `warnings` are
 * legal but worth telling the player about.
 */
export function checkLegality(reg, a) {
  const errors = [];
  const warnings = [];
  const { weightClass, legality } = reg.rules;
  const capLb = weightClass.cap;
  const limitLb = capLb + weightClass.tolerance;

  if (a.weightLb > limitLb) {
    errors.push(`Overweight: ${a.weightLb.toFixed(1)} lb exceeds the ${capLb} lb cap.`);
  } else if (a.weightLb > capLb - 2) {
    warnings.push(`Only ${(capLb - a.weightLb).toFixed(1)} lb under the cap - no room for repairs.`);
  }

  // Weapon legality, against the DERIVED output rather than a stated number -
  // so you cannot sneak an over-energy rotor past the inspection by not
  // mentioning it in the data.
  const weapon = a.parts.weapon;
  const wstats = a.stats.weapon;
  if (weapon) {
    if (legality.bannedWeaponClasses.includes(wstats.class)) {
      errors.push(`Banned weapon class: "${wstats.class}".`);
    }
    if (wstats.tipSpeedMps > legality.maxWeaponTipSpeedMps) {
      errors.push(`Weapon tip speed ${wstats.tipSpeedMps.toFixed(0)} m/s exceeds the ${legality.maxWeaponTipSpeedMps} m/s limit.`);
    }
    if (wstats.energyJ > legality.maxWeaponEnergyJ) {
      errors.push(`Weapon energy ${(wstats.energyJ / 1000).toFixed(1)} kJ exceeds the ${(legality.maxWeaponEnergyJ / 1000).toFixed(0)} kJ limit.`);
    }

    // A powered weapon needs a motor, and the motor has to be up to the rotor.
    if (wstats.powered && !a.parts.weaponMotor) {
      errors.push(`"${weapon.name}" is a powered weapon but no weapon motor is fitted.`);
    }
    if (wstats.powered && a.parts.weaponMotor) {
      const cap = a.parts.weaponMotor.spec.maxEnergyJ;
      if (wstats.energyJ > cap) {
        errors.push(
          `"${a.parts.weaponMotor.name}" is rated to ${(cap / 1000).toFixed(0)} kJ but ` +
          `"${weapon.name}" stores ${(wstats.energyJ / 1000).toFixed(1)} kJ.`
        );
      }
      if (wstats.spinUpS > 20) {
        warnings.push(`Weapon takes ${wstats.spinUpS.toFixed(0)} s to reach full speed - most of the match.`);
      }
    }
    if (!wstats.powered && a.parts.weaponMotor) {
      warnings.push(`Weapon motor fitted but "${weapon.name}" is unpowered - that is ${a.parts.weaponMotor.weight} lb wasted.`);
    }
  } else {
    warnings.push("No weapon fitted - this build can only push.");
  }

  // Safety hardware.
  const ecu = a.parts.electronics.spec;
  if (legality.requireRemovableLink && !ecu.hasRemovableLink) {
    errors.push("Electronics lack a removable power link.");
  }
  if (legality.requirePowerSwitch && !ecu.hasPowerSwitch) {
    errors.push("Electronics lack a master power switch.");
  }
  if (a.parts.battery.spec.nominalV > legality.maxBatteryVoltageNominal) {
    errors.push(`Battery ${a.parts.battery.spec.nominalV} V exceeds the ${legality.maxBatteryVoltageNominal} V limit.`);
  }

  // Mechanical coherence.
  if (a.parts.wheel.spec.count < a.parts.drive.spec.wheelCount) {
    errors.push(`Drive wants ${a.parts.drive.spec.wheelCount} wheels but the wheel set has ${a.parts.wheel.spec.count}.`);
  }
  if (a.parts.motor.spec.count < a.parts.drive.spec.motorSlots) {
    errors.push(`Drive has ${a.parts.drive.spec.motorSlots} motor slots but only ${a.parts.motor.spec.count} motors are fitted.`);
  }
  if (a.parts.motor.spec.role !== "drive") {
    errors.push(`Motor "${a.parts.motor.id}" is not a drive motor.`);
  }

  // Armour must fit the chassis' available slots.
  const allowed = a.parts.chassis.spec.armorSlots || {};
  const used = {};
  for (const panel of a.parts.armor) {
    const slot = panel.spec.slot;
    used[slot] = (used[slot] || 0) + 1;
  }
  for (const [slot, count] of Object.entries(used)) {
    const max = allowed[slot] || 0;
    if (count > max) {
      errors.push(`Chassis takes ${max} "${slot}" armour panel(s) but ${count} are fitted.`);
    }
  }
  // A build that physically cannot pivot is legal but unusable.
  if (a.stats.pivotAuthority < 1.0) {
    errors.push(
      `This build cannot turn: drive torque about the yaw axis ` +
      `(${a.stats.pivotDriveTorqueNm.toFixed(0)} Nm) is below the grip resisting it ` +
      `(${a.stats.pivotResistTorqueNm.toFixed(0)} Nm). Drive more wheels, fit stronger ` +
      `motors, or use a narrower wheelbase.`
    );
  } else if (a.stats.pivotAuthority < 1.3) {
    warnings.push(`Turns poorly - only ${a.stats.pivotAuthority.toFixed(2)}x the grip resisting a pivot.`);
  }

  if (!used.front) warnings.push("No front armour - the most-hit face is bare.");
  if (!used.top) warnings.push("No top armour - vulnerable to vertical spinners and hammers.");

  return {
    legal: errors.length === 0,
    errors,
    warnings,
    weightLb: a.weightLb,
    capLb,
    marginLb: round2(capLb - a.weightLb),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
