import { patchOnBeforeCompile } from "./vendor/utils/shaderPatch.js";

/**
 * Creates a minimal environment shim that satisfies the upstream ability system’s
 * dependency on a shadow-caster registration hook. The ice/meteor materials only
 * need this single hook from their Environment, so the full upstream context is
 * unnecessary.
 *
 * @returns An object with a `registerShadowCasterWithPatch` method that applies
 *          a shader patch to a material via `patchOnBeforeCompile`.
 */
export function createLinearCastingEnvironment() {
  return {
    registerShadowCasterWithPatch(material: { onBeforeCompile?: unknown }, patch: (...args: unknown[]) => void) {
      patchOnBeforeCompile(material, patch);
      return material;
    },
  };
}
