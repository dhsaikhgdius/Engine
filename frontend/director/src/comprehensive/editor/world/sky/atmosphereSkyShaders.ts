/**
 * GLSL shader sources for the procedural atmosphere sky dome.
 *
 * @module director/world/sky/atmosphereSkyShaders
 */

/** Vertex shader for the atmosphere sky dome — positions a far-clip sphere. */
export const ATMOSPHERE_SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldDir;

  void main() {
    vWorldDir = mat3(modelMatrix) * position;
    // Stay inside the 10 km far clip, well behind kilometre-scale sets.
    // Do not force clip.z = clip.w: Director uses a reversed-Z buffer, so
    // that hack would put the dome on the near plane and hide the scene.
    vec3 world = cameraPosition + normalize(vWorldDir) * 4000.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

/** Fragment shader for the atmosphere sky dome — evaluates Rayleigh/Mie scattering. */
export const ATMOSPHERE_SKY_FRAGMENT_SHADER = /* glsl */ `
  #include <common>

  uniform sampler2D skyLUT;
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform float sunIntensity;
  uniform float cloudAmount;
  uniform float time;
  uniform vec2 windDir;

  varying vec3 vWorldDir;

  vec2 dirToLatLong(vec3 d) {
    vec3 n = normalize(d);
    float u = atan(n.x, n.z) / (2.0 * PI) + 0.5;
    float v = acos(clamp(n.y, -1.0, 1.0)) / PI;
    return vec2(u, v);
  }

  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash22(i).x;
    float b = hash22(i + vec2(1.0, 0.0)).x;
    float c = hash22(i + vec2(0.0, 1.0)).x;
    float d = hash22(i + vec2(1.0, 1.0)).x;
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = p * 2.07 + vec2(11.3, 4.7);
      a *= 0.52;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    vec3 col = texture2D(skyLUT, dirToLatLong(dir)).rgb;

    float mu = dot(dir, sunDir);
    float discCos = cos(0.0046);
    if (mu > discCos) {
      float r = sqrt(max(0.0, 1.0 - mu * mu)) / 0.0046;
      float limb = pow(max(0.0, 1.0 - r * r * 0.72), 0.42);
      col += sunColor * 8.0 * limb;
    }
    float aureole = pow(max(0.0, mu), 1800.0) * 2.4 + pow(max(0.0, mu), 96.0) * 0.12;
    col += sunColor * aureole;

    if (cloudAmount > 0.04 && dir.y > 0.02) {
      float planeY = 1.0 / max(0.06, dir.y);
      vec2 cp = dir.xz * planeY * 0.5 + windDir * time * 0.004;
      float a = atan(windDir.x, windDir.y);
      float cs = cos(a);
      float sn = sin(a);
      cp = vec2(cs * cp.x + sn * cp.y, -sn * cp.x + cs * cp.y);
      cp.x *= 0.28;
      float n = fbm(cp);
      float cloud = smoothstep(0.18, 0.42, n);
      cloud *= smoothstep(0.02, 0.22, dir.y) * (1.0 - smoothstep(0.55, 1.0, dir.y) * 0.45);
      cloud *= cloudAmount;
      float sunLit = pow(max(0.0, mu * 0.5 + 0.5), 3.0);
      vec3 cloudCol = mix(vec3(0.62, 0.68, 0.78), sunColor * 1.05, sunLit * 0.55);
      col = mix(col, cloudCol * (0.72 + sunIntensity * 0.04), cloud * 0.35);
    }

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
