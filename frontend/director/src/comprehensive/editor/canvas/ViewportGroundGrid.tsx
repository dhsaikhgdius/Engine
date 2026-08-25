import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Color,
  DoubleSide,
  Mesh,
  Plane,
  ShaderMaterial,
  Vector3,
  type ColorRepresentation,
  type IUniform,
  type Side,
} from "three";

import {
  VIEWPORT_GRID_CELL_SIZE,
  VIEWPORT_GRID_CELL_THICKNESS,
  VIEWPORT_GRID_FADE_STRENGTH,
  VIEWPORT_GRID_MAJOR_DENSITY_FADE,
  VIEWPORT_GRID_MINOR_DENSITY_FADE,
  VIEWPORT_GRID_SECTION_SIZE,
  VIEWPORT_GRID_SECTION_THICKNESS,
} from "./viewportWheelZoom";

const VIEWPORT_GROUND_GRID_VERTEX_SHADER = /* glsl */ `
  varying vec3 localPosition;
  varying vec4 worldPosition;

  uniform vec3 worldCamProjPosition;
  uniform vec3 worldPlanePosition;
  uniform float fadeDistance;
  uniform bool infiniteGrid;
  uniform bool followCamera;

  void main() {
    localPosition = position.xzy;
    if (infiniteGrid) localPosition *= 1.0 + fadeDistance;

    worldPosition = modelMatrix * vec4(localPosition, 1.0);
    if (followCamera) {
      worldPosition.xyz += (worldCamProjPosition - worldPlanePosition);
      localPosition = (inverse(modelMatrix) * worldPosition).xyz;
    }

    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const VIEWPORT_GROUND_GRID_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 localPosition;
  varying vec4 worldPosition;

  uniform vec3 worldCamProjPosition;
  uniform float cellSize;
  uniform float sectionSize;
  uniform vec3 cellColor;
  uniform vec3 sectionColor;
  uniform float fadeDistance;
  uniform float fadeStrength;
  uniform float fadeFrom;
  uniform float cellThickness;
  uniform float sectionThickness;
  uniform float minorDensityFadeStart;
  uniform float minorDensityFadeEnd;
  uniform float majorDensityFadeStart;
  uniform float majorDensityFadeEnd;

  float getGrid(float size, float thickness) {
    vec2 r = localPosition.xz / size;
    vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);
    float line = min(grid.x, grid.y) + 1.0 - thickness;
    return 1.0 - min(line, 1.0);
  }

  float densityFade(float size, float fadeStart, float fadeEnd) {
    float freq = length(fwidth(localPosition.xz / size));
    return 1.0 - smoothstep(fadeStart, fadeEnd, freq);
  }

  void main() {
    float g1 = getGrid(cellSize, cellThickness) * densityFade(cellSize, minorDensityFadeStart, minorDensityFadeEnd);
    float g2 = getGrid(sectionSize, sectionThickness) * densityFade(sectionSize, majorDensityFadeStart, majorDensityFadeEnd);

    vec3 from = worldCamProjPosition * fadeFrom;
    float dist = distance(from, worldPosition.xyz);
    float distanceFade = pow(1.0 - min(dist / fadeDistance, 1.0), fadeStrength);
    vec3 color = mix(cellColor, sectionColor, min(1.0, sectionThickness * g2));
    float alpha = (g1 + g2) * distanceFade;
    gl_FragColor = vec4(color, mix(0.75 * alpha, alpha, g2));
    if (gl_FragColor.a <= 0.0) discard;
  }
`;

interface ViewportGroundGridUniforms {
  cellSize: IUniform<number>;
  sectionSize: IUniform<number>;
  fadeDistance: IUniform<number>;
  fadeStrength: IUniform<number>;
  fadeFrom: IUniform<number>;
  cellThickness: IUniform<number>;
  sectionThickness: IUniform<number>;
  cellColor: IUniform<Color>;
  sectionColor: IUniform<Color>;
  infiniteGrid: IUniform<boolean>;
  followCamera: IUniform<boolean>;
  minorDensityFadeStart: IUniform<number>;
  minorDensityFadeEnd: IUniform<number>;
  majorDensityFadeStart: IUniform<number>;
  majorDensityFadeEnd: IUniform<number>;
  worldCamProjPosition: IUniform<Vector3>;
  worldPlanePosition: IUniform<Vector3>;
}

type ViewportGroundGridMaterial = ShaderMaterial & { uniforms: ViewportGroundGridUniforms };

export interface ViewportGroundGridProps {
  cellColor: ColorRepresentation;
  sectionColor: ColorRepresentation;
  fadeDistance: number;
  cellSize?: number;
  cellThickness?: number;
  fadeFrom?: number;
  fadeStrength?: number;
  followCamera?: boolean;
  infiniteGrid?: boolean;
  position?: [number, number, number];
  sectionSize?: number;
  sectionThickness?: number;
  side?: Side;
  userData?: Record<string, unknown>;
}

/**
 * Stage ground grid: metric 1 m / 10 m cells, distance fade, and a screen-space
 * density fade so grazing lines dissolve instead of stacking into a horizon band.
 */
export function ViewportGroundGrid({
  cellColor,
  sectionColor,
  fadeDistance,
  cellSize = VIEWPORT_GRID_CELL_SIZE,
  cellThickness = VIEWPORT_GRID_CELL_THICKNESS,
  fadeFrom = 1,
  fadeStrength = VIEWPORT_GRID_FADE_STRENGTH,
  followCamera = true,
  infiniteGrid = true,
  position,
  sectionSize = VIEWPORT_GRID_SECTION_SIZE,
  sectionThickness = VIEWPORT_GRID_SECTION_THICKNESS,
  side = DoubleSide,
  userData,
}: ViewportGroundGridProps) {
  const meshRef = useRef<Mesh>(null);
  const plane = useMemo(() => new Plane(), []);
  const upVector = useMemo(() => new Vector3(0, 1, 0), []);
  const zeroVector = useMemo(() => new Vector3(), []);
  const material = useMemo(() => {
    const next = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        cellSize: { value: cellSize },
        sectionSize: { value: sectionSize },
        fadeDistance: { value: fadeDistance },
        fadeStrength: { value: fadeStrength },
        fadeFrom: { value: fadeFrom },
        cellThickness: { value: cellThickness },
        sectionThickness: { value: sectionThickness },
        cellColor: { value: new Color(cellColor) },
        sectionColor: { value: new Color(sectionColor) },
        infiniteGrid: { value: infiniteGrid },
        followCamera: { value: followCamera },
        minorDensityFadeStart: { value: VIEWPORT_GRID_MINOR_DENSITY_FADE.start },
        minorDensityFadeEnd: { value: VIEWPORT_GRID_MINOR_DENSITY_FADE.end },
        majorDensityFadeStart: { value: VIEWPORT_GRID_MAJOR_DENSITY_FADE.start },
        majorDensityFadeEnd: { value: VIEWPORT_GRID_MAJOR_DENSITY_FADE.end },
        worldCamProjPosition: { value: new Vector3() },
        worldPlanePosition: { value: new Vector3() },
      },
      vertexShader: VIEWPORT_GROUND_GRID_VERTEX_SHADER,
      fragmentShader: VIEWPORT_GROUND_GRID_FRAGMENT_SHADER,
    }) as ViewportGroundGridMaterial;
    return next;
    // Uniforms sync in the layout effect so the material is not rebuilt every orbit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    material.side = side;
    material.uniforms.cellSize.value = cellSize;
    material.uniforms.sectionSize.value = sectionSize;
    material.uniforms.fadeDistance.value = fadeDistance;
    material.uniforms.fadeStrength.value = fadeStrength;
    material.uniforms.fadeFrom.value = fadeFrom;
    material.uniforms.cellThickness.value = cellThickness;
    material.uniforms.sectionThickness.value = sectionThickness;
    material.uniforms.cellColor.value.set(cellColor);
    material.uniforms.sectionColor.value.set(sectionColor);
    material.uniforms.infiniteGrid.value = infiniteGrid;
    material.uniforms.followCamera.value = followCamera;
    material.needsUpdate = true;
  }, [
    cellColor,
    cellSize,
    cellThickness,
    fadeDistance,
    fadeFrom,
    fadeStrength,
    followCamera,
    infiniteGrid,
    material,
    sectionColor,
    sectionSize,
    sectionThickness,
    side,
  ]);

  useLayoutEffect(() => () => material.dispose(), [material]);

  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    plane.setFromNormalAndCoplanarPoint(upVector, zeroVector).applyMatrix4(mesh.matrixWorld);
    plane.projectPoint(camera.position, material.uniforms.worldCamProjPosition.value);
    material.uniforms.worldPlanePosition.value.set(0, 0, 0).applyMatrix4(mesh.matrixWorld);
  });

  return (
    <mesh
      ref={meshRef}
      frustumCulled={false}
      material={material}
      name="director-viewport-ground-grid-mesh"
      position={position}
      userData={userData}
    >
      <planeGeometry />
    </mesh>
  );
}
