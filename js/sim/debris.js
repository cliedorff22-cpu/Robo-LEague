// debris.js - flying parts.
//
// When a part fails, chunks of it come off and bounce around the arena. These
// are REAL dynamic bodies, not a particle effect: they tumble, hit the walls,
// slide to a stop and get in the way, which is most of why debris sells a big
// hit. Bots do not collide with them (they would be a drag on the fight), but
// the arena does.
//
// Pooled and capped: a long match with a lot of carnage must not end up
// simulating four hundred rigid bodies.

import { RAPIER } from "./physics.js";
import { GROUP } from "./world.js";

const MAX_PIECES = 48;
const DEFAULT_LIFETIME_S = 14;

// Debris collides with the arena and other debris, but NOT with robots.
const DEBRIS_FILTER = ((GROUP.HAZARD << 16) | (GROUP.ARENA | GROUP.HAZARD));

export function makeDebris({ sim, rng }) {
  const world = sim.world;
  const pieces = [];     // { body, collider, size, kind, bornS, lifetimeS, materialName }
  let clockS = 0;

  function spawnOne({ at, velocity, size, materialName, lifetimeS }) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
        .setLinvel(velocity.x, velocity.y, velocity.z)
        .setAngvel({
          x: (rng.next() - 0.5) * 30,
          y: (rng.next() - 0.5) * 30,
          z: (rng.next() - 0.5) * 30,
        })
        .setLinearDamping(0.15)
        .setAngularDamping(0.2)
        .setCcdEnabled(false)
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setDensity(1200)
        .setFriction(0.6)
        .setRestitution(0.35)
        .setCollisionGroups(DEBRIS_FILTER),
      body
    );
    const piece = {
      body, collider, size, materialName,
      bornS: clockS,
      lifetimeS: lifetimeS ?? DEFAULT_LIFETIME_S,
      id: `${materialName}-${clockS.toFixed(3)}-${pieces.length}`,
    };
    pieces.push(piece);
    return piece;
  }

  function remove(piece) {
    world.removeRigidBody(piece.body);   // takes its collider with it
  }

  return {
    get pieces() { return pieces; },
    get count() { return pieces.length; },

    /**
     * Throw a handful of fragments off a failed part.
     *
     * @param {object} o
     * @param {object} o.at            world point to spawn at
     * @param {object} o.normal        surface normal, biases the spray outward
     * @param {number} o.energyJ       how hard the hit was - sets how far they fly
     * @param {string} o.materialName  a key from the material library, so a steel
     *                                 panel sheds steel and a UHMW one sheds white
     * @param {number} o.count
     * @param {number} o.scale         fragment size in metres
     */
    burst({ at, normal = { x: 0, y: 1, z: 0 }, energyJ = 2000, materialName = "ar500_steel", count = 5, scale = 0.07 }) {
      if (!at) return [];
      const made = [];
      // Speed from energy, capped so a 33 kJ bar does not fire shrapnel at
      // escape velocity.
      const speed = Math.min(14, 2 + Math.sqrt(Math.max(0, energyJ)) * 0.06);

      for (let i = 0; i < count; i++) {
        if (pieces.length >= MAX_PIECES) {
          // Recycle the oldest rather than refusing to show the hit.
          const oldest = pieces.shift();
          if (oldest) remove(oldest);
        }
        const spread = 0.85;
        const v = {
          x: normal.x * speed + (rng.next() - 0.5) * speed * spread,
          y: Math.abs(normal.y) * speed * 0.5 + rng.next() * speed * 0.8 + 1.5,
          z: normal.z * speed + (rng.next() - 0.5) * speed * spread,
        };
        const s = scale * (0.55 + rng.next() * 0.9);
        made.push(spawnOne({
          at: {
            x: at.x + (rng.next() - 0.5) * 0.05,
            y: at.y + (rng.next() - 0.5) * 0.05 + 0.02,
            z: at.z + (rng.next() - 0.5) * 0.05,
          },
          velocity: v,
          size: { x: s, y: s * (0.3 + rng.next() * 0.5), z: s * (0.6 + rng.next() * 0.7) },
          materialName,
        }));
      }
      return made;
    },

    /** Retire expired pieces. Call once per physics step. */
    update(dt) {
      clockS += dt;
      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i];
        if (clockS - p.bornS < p.lifetimeS) continue;
        remove(p);
        pieces.splice(i, 1);
      }
    },

    /** Live transforms, for the renderer to mirror. */
    transforms() {
      return pieces.map((p) => ({
        id: p.id, size: p.size, materialName: p.materialName,
        pos: p.body.translation(), quat: p.body.rotation(),
        age: clockS - p.bornS, lifetimeS: p.lifetimeS,
      }));
    },

    clear() {
      for (const p of pieces) remove(p);
      pieces.length = 0;
      clockS = 0;
    },
  };
}

export { MAX_PIECES };
