precision highp float;

uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uTexelSize;
uniform float uNear;
uniform float uFar;
uniform float uFocusDistanceM;
uniform float uFocalLengthM;
uniform float uApertureFStop;
uniform float uSensorHeightM;
uniform float uOutputHeightPx;
uniform float uMaxBlurPx;
uniform float uSampleCount;
uniform float uRenderScale;
uniform float uAnamorphicSqueeze;
uniform float uReversedDepthBuffer;

varying vec2 vUv;

const int MAX_SAMPLES = 20;
const float GOLDEN_ANGLE = 2.39996323;

float viewDistance(float depth) {
  // A reversed depth buffer stores 1 at the near plane and 0 at the far plane,
  // so it needs the inverted perspective linearization.
  float viewZ = uReversedDepthBuffer > 0.5
    ? -(uNear * uFar) / (uNear + depth * (uFar - uNear))
    : (uNear * uFar) / ((uFar - uNear) * depth - uFar);
  return max(-viewZ, uNear);
}

float cocPixels(float distanceM) {
  float focalM = max(uFocalLengthM, 0.000001);
  float focusM = max(uFocusDistanceM, focalM + 0.000001);
  float subjectM = max(distanceM, focalM + 0.000001);
  float cocM = abs((focalM * focalM * (focusM - subjectM)) /
    (max(uApertureFStop, 0.1) * subjectM * (focusM - focalM)));
  return min(uMaxBlurPx, (cocM / max(uSensorHeightM, 0.000001)) * uOutputHeightPx);
}

void main() {
  float centerDistance = viewDistance(texture2D(uDepth, vUv).x);
  float blurPx = cocPixels(centerDistance);
  if (blurPx < 0.35) {
    gl_FragColor = texture2D(uColor, vUv);
    return;
  }

  vec4 sum = texture2D(uColor, vUv);
  float totalWeight = 1.0;
  float squeezeRoot = sqrt(max(uAnamorphicSqueeze, 1.0));
  vec2 oval = vec2(1.0 / squeezeRoot, squeezeRoot);

  for (int i = 0; i < MAX_SAMPLES; i++) {
    if (float(i) >= uSampleCount) break;
    float normalizedIndex = (float(i) + 0.5) / max(uSampleCount, 1.0);
    float radius = sqrt(normalizedIndex) * blurPx * uRenderScale;
    float angle = float(i) * GOLDEN_ANGLE;
    vec2 offset = vec2(cos(angle), sin(angle)) * radius * uTexelSize * oval;
    vec2 sampleUv = clamp(vUv + offset, vec2(0.0), vec2(1.0));
    float sampleDistance = viewDistance(texture2D(uDepth, sampleUv).x);
    float sampleBlurPx = cocPixels(sampleDistance);
    float depthDelta = abs(sampleDistance - centerDistance) / max(centerDistance, 0.001);
    float blurSupport = smoothstep(0.2, 1.2, max(blurPx, sampleBlurPx));
    float depthWeight = 1.0 / (1.0 + depthDelta * 2.0);
    float weight = max(0.05, blurSupport * depthWeight);
    sum += texture2D(uColor, sampleUv) * weight;
    totalWeight += weight;
  }

  gl_FragColor = sum / totalWeight;
}
