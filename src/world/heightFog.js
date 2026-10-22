import * as THREE from 'three';

/**
 * Height fog: patches three.js' fog shader chunks (once, before any material
 * compiles) so the scene's linear fog is densest near the ground and thins
 * out with altitude. Tall buildings rise out of the haze and fog weather
 * hugs the streets instead of greying the whole sky.
 *
 * The world-space height is reconstructed in the vertex shader from the
 * view-space position (works for instanced, batched and skinned meshes).
 * FOG_HEIGHT_FALLOFF: e-folding per metre above the street.
 */
let installed = false;

export function installHeightFog() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogHeight;
#endif`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // World y = camera y + (inverse view rotation * view-space position).y
  // (p_world = R^T p_view + C, so world y uses column 1 of the view rotation)
  vFogHeight = cameraPosition.y + dot( viewMatrix[1].xyz, mvPosition.xyz );
#endif`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  #define FOG_HEIGHT_FALLOFF 0.018
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogHeight;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  // Thinner with height: full density at street level, ~40% at 50 m.
  float fogHeight = exp( - max( vFogHeight, 0.0 ) * FOG_HEIGHT_FALLOFF );
  fogFactor *= mix( 0.3, 1.0, fogHeight );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
}
