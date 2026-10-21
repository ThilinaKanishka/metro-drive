/**
 * Uniforms shared by several custom materials. The day/night system writes
 * `uNight` (0 = full day, 1 = full night) each frame and every material that
 * references this object reacts automatically (windows, lamps, light pools).
 */
export const worldUniforms = {
  uNight: { value: 0 },
};

/** Patch a material so it reads a shared uniform object. */
export function shareUniforms(shader) {
  shader.uniforms.uNight = worldUniforms.uNight;
}
