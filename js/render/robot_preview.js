// robot_preview.js - a robot posed at rest with no physics, for menus.
//
// buildRobotView() draws a robot from its sim: the shape pieces, the wheel
// mounts and the suspension state. In the menus there is no physics world, so
// this supplies the same description from pure logic - shape.js for the body,
// wheel_model.js for where the wheels sit - with every wheel on the floor at
// its resting compression. It is the same geometry the fight uses, so the bot
// you pick is the bot that turns up (README rule 4).

import { buildShape, routeFittings } from "../logic/shape.js";
import { wheelLayout, SUSPENSION_PRELOAD } from "../sim/wheel_model.js";

/** A stand-in for robot_sim, enough for buildRobotView to draw a parked bot. */
export function previewSim(assembled, offset = { x: 0, z: 0 }) {
  const shape = buildShape(assembled);
  const layout = wheelLayout(assembled);
  const pose = {
    pos: { x: offset.x, y: layout.spawnY, z: offset.z },
    quat: { x: 0, y: 0, z: 0, w: 1 },
  };
  return {
    assembled,
    shape,
    routes: routeFittings(shape, assembled),
    wheels: layout.wheels,
    suspension: { restLength: layout.restLength, preload: SUSPENSION_PRELOAD },
    telemetry: layout.wheels.map(() => ({ grounded: true, compression: SUSPENSION_PRELOAD, spin: 0, load: 0, slip: 0 })),
    wheelAnchor: (i) => layout.wheels[i].anchor,
    inverted: false,
    pose: () => pose,
  };
}
