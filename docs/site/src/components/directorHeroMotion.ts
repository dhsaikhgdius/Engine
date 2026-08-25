/**
 * Director home page hero WebGL background animation.
 *
 * @module docs/site/directorHeroMotion
 */

import { isDirectorHomeLightTheme } from "./directorHomeTheme";

const vertexShaderSource = `
  attribute vec2 a_position;
  varying vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision highp float;

  uniform sampler2D u_texture_dark;
  uniform sampler2D u_texture_light;
  uniform vec2 u_viewport;
  uniform vec2 u_image;
  uniform vec2 u_focus;
  uniform vec2 u_pointer;
  uniform float u_time;
  uniform float u_light_mix;
  uniform float u_pointer_strength;

  varying vec2 v_uv;

  float hash(vec2 point) {
    point = fract(point * vec2(123.34, 456.21));
    point += dot(point, point + 45.32);
    return fract(point.x * point.y);
  }

  float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    vec2 blend = local * local * (3.0 - 2.0 * local);

    return mix(
      mix(hash(cell), hash(cell + vec2(1.0, 0.0)), blend.x),
      mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), blend.x),
      blend.y
    );
  }

  float fbm(vec2 point) {
    float value = noise(point) * 0.5714;
    point = point * 2.03 + vec2(4.7, 1.3);
    value += noise(point) * 0.2857;
    point = point * 2.01 + vec2(2.1, 5.4);
    value += noise(point) * 0.1429;
    return value;
  }

  vec2 coverUv(vec2 uv) {
    float viewportAspect = u_viewport.x / u_viewport.y;
    float imageAspect = u_image.x / u_image.y;
    vec2 crop = vec2(1.0);

    if (viewportAspect < imageAspect) {
      crop.x = viewportAspect / imageAspect;
    } else {
      crop.y = imageAspect / viewportAspect;
    }

    return (uv - vec2(0.5)) * crop + u_focus;
  }

  void main() {
    vec2 screenUv = v_uv;
    vec2 textureUv = coverUv(screenUv);

    vec2 field = screenUv * vec2(2.15, 1.85);
    vec2 flow = vec2(
      fbm(field + vec2(u_time * 0.011, -u_time * 0.007)),
      fbm(field + vec2(4.3, -2.7) + vec2(-u_time * 0.008, u_time * 0.010))
    ) - 0.5;

    float titleGuard = smoothstep(
      0.12,
      0.58,
      distance(screenUv * vec2(1.0, 1.18), vec2(0.5, 0.73) * vec2(1.0, 1.18))
    );
    float displacement = mix(0.0024, 0.0105, titleGuard);

    vec2 longWave = vec2(
      sin(screenUv.y * 6.2 + u_time * 0.105),
      cos(screenUv.x * 5.4 - u_time * 0.087)
    ) * 0.0016;

    textureUv += flow * displacement + longWave * titleGuard;

    float viewportAspect = u_viewport.x / u_viewport.y;
    vec2 pointerVector = (screenUv - u_pointer) * vec2(viewportAspect, 1.0);
    float pointerDistance = length(pointerVector);
    float pointerField = exp(-pointerDistance * pointerDistance * 8.5) * u_pointer_strength;
    vec2 pointerDirection = pointerVector / (pointerDistance + 0.001);
    vec2 pointerLens = vec2(pointerDirection.x / viewportAspect, pointerDirection.y);
    textureUv += pointerLens * pointerField * 0.0065;
    textureUv += (u_pointer - vec2(0.5)) * u_pointer_strength * 0.0032;

    float breathing = 0.5 + 0.5 * sin(u_time * 0.115);
    float zoom = 1.006 + breathing * 0.008;
    textureUv = u_focus + (textureUv - u_focus) / zoom;
    textureUv = clamp(textureUv, vec2(0.001), vec2(0.999));

    vec3 darkColor = texture2D(u_texture_dark, textureUv).rgb;
    vec3 lightColor = texture2D(u_texture_light, textureUv).rgb;
    vec3 color = mix(darkColor, lightColor, u_light_mix);
    vec2 glowPoint = (screenUv - vec2(0.53, 0.59)) * vec2(1.0, 1.35);
    float centerGlow = exp(-dot(glowPoint, glowPoint) * 7.5);
    color *= 0.997 + centerGlow * (0.015 + breathing * 0.014);
    float pointerPulse = 0.5 + 0.5 * sin(u_time * 0.9);
    color *= 1.0 + pointerField * (0.022 + pointerPulse * 0.01);

    gl_FragColor = vec4(color, 1.0);
  }
`;

const getLightMix = (seconds: number) => {
  const phase = seconds % 38;
  const ease = (value: number) => 0.5 - 0.5 * Math.cos(Math.PI * value);

  if (phase < 6) return 1;
  if (phase < 14) return 1 - ease((phase - 6) / 8);
  if (phase < 24) return 0;
  if (phase < 32) return ease((phase - 24) / 8);
  return 1;
};

const advanceSpring = (
  value: number,
  target: number,
  velocity: number,
  delta: number,
) => {
  const nextVelocity = velocity + ((target - value) * 100 - velocity * 10) * delta;
  return [value + nextVelocity * delta, nextVelocity] as const;
};

const createShader = (
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null => {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }

  return shader;
};

export const mountDirectorHeroMotion = () => {
  const canvas = document.querySelector<HTMLCanvasElement>("[data-hero-motion]");
  const darkPoster = document.querySelector<HTMLImageElement>(".dh-hero-atmosphere");
  const lightPoster = document.querySelector<HTMLImageElement>(".dh-hero-atmosphere-light");
  const hero = canvas?.closest<HTMLElement>(".dh-hero");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const precisePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  if (!canvas || !darkPoster || !lightPoster || !hero || reducedMotion.matches) return;

  const initialize = () => {
    if (
      !darkPoster.naturalWidth ||
      !lightPoster.naturalWidth ||
      canvas.dataset.motionMounted === "true"
    ) return;
    canvas.dataset.motionMounted = "true";

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
      premultipliedAlpha: false,
      stencil: false,
    });
    if (!gl) return;

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertexShader || !fragmentShader) return;

    const program = gl.createProgram();
    if (!program) return;

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

    const positionBuffer = gl.createBuffer();
    const darkTexture = gl.createTexture();
    const lightTexture = gl.createTexture();
    if (!positionBuffer || !darkTexture || !lightTexture) return;

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
      ]),
      gl.STATIC_DRAW,
    );

    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, darkTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, darkPoster);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lightTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lightPoster);

    const viewportUniform = gl.getUniformLocation(program, "u_viewport");
    const imageUniform = gl.getUniformLocation(program, "u_image");
    const focusUniform = gl.getUniformLocation(program, "u_focus");
    const pointerUniform = gl.getUniformLocation(program, "u_pointer");
    const timeUniform = gl.getUniformLocation(program, "u_time");
    const lightMixUniform = gl.getUniformLocation(program, "u_light_mix");
    const pointerStrengthUniform = gl.getUniformLocation(program, "u_pointer_strength");
    const darkTextureUniform = gl.getUniformLocation(program, "u_texture_dark");
    const lightTextureUniform = gl.getUniformLocation(program, "u_texture_light");

    gl.uniform1i(darkTextureUniform, 0);
    gl.uniform1i(lightTextureUniform, 1);
    gl.uniform2f(imageUniform, darkPoster.naturalWidth, darkPoster.naturalHeight);

    const resize = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const pixelScale = Math.min(window.devicePixelRatio || 1, 1.25, 1920 / width);

      canvas.width = Math.round(width * pixelScale);
      canvas.height = Math.round(height * pixelScale);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(viewportUniform, canvas.width, canvas.height);

      const styles = getComputedStyle(canvas);
      const focusX = Number.parseFloat(styles.getPropertyValue("--dh-motion-focus-x")) || 0.5;
      const focusY = Number.parseFloat(styles.getPropertyValue("--dh-motion-focus-y")) || 0.55;
      gl.uniform2f(focusUniform, focusX, focusY);
    };

    let animationFrame = 0;
    let elapsed = 0;
    let lastTick = 0;
    let lastDraw = 0;
    let isVisible = true;
    let pointerX = 0.5;
    let pointerY = 0.5;
    let pointerStrength = 0;
    let pointerVelocityX = 0;
    let pointerVelocityY = 0;
    let pointerStrengthVelocity = 0;
    let targetPointerX = 0.5;
    let targetPointerY = 0.5;
    let targetPointerStrength = 0;

    const handlePointerMove = (event: PointerEvent) => {
      const bounds = hero.getBoundingClientRect();
      targetPointerX = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
      targetPointerY = 1 - Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
      targetPointerStrength = 1;
    };

    const handlePointerLeave = () => {
      targetPointerStrength = 0;
    };

    if (precisePointer.matches) {
      hero.addEventListener("pointermove", handlePointerMove, { passive: true });
      hero.addEventListener("pointerleave", handlePointerLeave);
      hero.addEventListener("pointercancel", handlePointerLeave);
    }

    const draw = () => {
      gl.uniform1f(timeUniform, elapsed);
      gl.uniform1f(
        lightMixUniform,
        isDirectorHomeLightTheme() ? 1 : getLightMix(elapsed),
      );
      gl.uniform2f(pointerUniform, pointerX, pointerY);
      gl.uniform1f(pointerStrengthUniform, Math.min(1, Math.max(0, pointerStrength)));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const frame = (now: number) => {
      animationFrame = 0;
      if (!isVisible || document.hidden) return;

      const delta = lastTick ? Math.min((now - lastTick) / 1000, 0.05) : 0;
      elapsed += delta;
      lastTick = now;

      if (delta) {
        [pointerX, pointerVelocityX] = advanceSpring(
          pointerX,
          targetPointerX,
          pointerVelocityX,
          delta,
        );
        [pointerY, pointerVelocityY] = advanceSpring(
          pointerY,
          targetPointerY,
          pointerVelocityY,
          delta,
        );
        [pointerStrength, pointerStrengthVelocity] = advanceSpring(
          pointerStrength,
          targetPointerStrength,
          pointerStrengthVelocity,
          delta,
        );
      }

      if (now - lastDraw >= 1000 / 30) {
        draw();
        lastDraw = now;
      }

      animationFrame = requestAnimationFrame(frame);
    };

    const start = () => {
      if (animationFrame || !isVisible || document.hidden) return;
      lastTick = 0;
      animationFrame = requestAnimationFrame(frame);
    };

    const stop = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      lastTick = 0;
    };

    const resizeObserver = new ResizeObserver(() => {
      resize();
      draw();
    });
    resizeObserver.observe(canvas);

    const visibilityObserver = new IntersectionObserver(([entry]) => {
      isVisible = entry.isIntersecting;
      if (isVisible) start();
      else stop();
    }, { rootMargin: "120px" });
    visibilityObserver.observe(hero);

    const handleVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    resize();
    draw();
    canvas.classList.add("is-ready");
    hero.classList.add("is-motion-ready");
    start();

    window.addEventListener("pagehide", () => {
      stop();
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      hero.removeEventListener("pointermove", handlePointerMove);
      hero.removeEventListener("pointerleave", handlePointerLeave);
      hero.removeEventListener("pointercancel", handlePointerLeave);
    }, { once: true });
  };

  if (darkPoster.complete && lightPoster.complete) initialize();
  else {
    darkPoster.addEventListener("load", initialize, { once: true });
    lightPoster.addEventListener("load", initialize, { once: true });
  }
};
