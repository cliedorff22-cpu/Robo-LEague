// post.js - the post-processing chain.
//
// Bloom is what makes sparks, weapon glow and the overhead practicals read as
// *light* rather than as bright pixels, so Stage 2's effects are built assuming
// it is here. A vignette pulls the eye into the middle of the box.
//
// Entirely data-driven from arena.json's `post` block, and entirely optional:
// `"enabled": false` falls back to rendering the scene straight to the canvas,
// with no composer in the way. If post-processing ever misbehaves on a machine,
// that one flag is the whole fix.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { VignetteShader } from "three/addons/shaders/VignetteShader.js";

/**
 * @returns {{ render(scene, camera): void, setSize(w, h): void, enabled: boolean, bloom: UnrealBloomPass|null }}
 */
export function makePost(renderer, scene, camera, arena) {
  const cfg = arena.post || {};

  if (cfg.enabled === false) {
    return {
      enabled: false,
      bloom: null,
      render: (s, c) => renderer.render(s, c),
      setSize: () => {},
      dispose: () => {},
    };
  }

  const size = renderer.getSize(new THREE.Vector2());
  // A multisampled target. The renderer's own `antialias: true` does nothing
  // once a composer is in the way - the scene is drawn into the composer's
  // target, which had no MSAA - so every thin edge (the lip along the top of
  // the far wall above all) stair-stepped and crawled as the camera moved.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(Math.min(devicePixelRatio, 2));
  composer.setSize(size.x, size.y);

  composer.addPass(new RenderPass(scene, camera));

  const b = cfg.bloom || {};
  // Threshold above 1.0 means only genuinely bright things bloom - the
  // practicals, sparks and hot metal - rather than every pale surface.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y),
    b.strength ?? 0.55,
    b.radius ?? 0.5,
    b.threshold ?? 0.95
  );
  composer.addPass(bloom);

  let vignette = null;
  if (cfg.vignette?.enabled !== false) {
    vignette = new ShaderPass(VignetteShader);
    vignette.uniforms.offset.value = cfg.vignette?.offset ?? 1.1;
    vignette.uniforms.darkness.value = cfg.vignette?.darkness ?? 1.25;
    composer.addPass(vignette);
  }

  // OutputPass does the tone mapping and colour-space conversion that the
  // renderer would otherwise have done on its own. Without it, a composed
  // scene comes out washed out and in the wrong colour space.
  composer.addPass(new OutputPass());

  return {
    enabled: true,
    composer,
    bloom,
    vignette,

    /** The camera can change between frames, so the render pass tracks it. */
    render(s, c) {
      const pass = composer.passes[0];
      if (pass && pass.camera !== c) pass.camera = c;
      composer.render();
    },

    setSize(w, h) {
      composer.setSize(w, h);
      bloom.setSize(w, h);
    },

    dispose() { composer.dispose?.(); },
  };
}
