import { describe, expect, it } from "vitest";
import { Color, RGBADepthPacking, ShaderLib, type WebGLProgramParametersWithUniforms } from "three";
import {
  WILDLIFE_PART_ANGLE_SLOTS,
  WILDLIFE_PART_AXIS_ATTRIBUTE,
  WILDLIFE_PART_ID_ATTRIBUTE,
  WILDLIFE_PART_PIVOT_ATTRIBUTE,
} from "../../../../../src/comprehensive/editor/world/wildlife/placeholderModels";
import {
  createWildlifePartDepthMaterial,
  createWildlifePartMaterial,
  injectWildlifePartFragmentShader,
  injectWildlifePartVertexShader,
  WILDLIFE_PART_ANGLES_ATTRIBUTE_0,
  WILDLIFE_PART_ANGLES_ATTRIBUTE_1,
  WILDLIFE_PART_VERTEX_PRELUDE,
} from "../../../../../src/comprehensive/editor/world/wildlife/wildlifePartMaterial";

function fakeShader(vertexShader: string, fragmentShader = ""): WebGLProgramParametersWithUniforms {
  return { vertexShader, fragmentShader, uniforms: {} } as unknown as WebGLProgramParametersWithUniforms;
}

describe("wildlife part vertex shader injection", () => {
  it("relies on anchors that exist in the real three shader sources", () => {
    // Guards three upgrades: if an anchor disappears, injection would no-op.
    for (const source of [ShaderLib.standard.vertexShader, ShaderLib.depth.vertexShader]) {
      expect(source).toContain("#include <common>");
      expect(source).toContain("#include <begin_vertex>");
    }
    expect(ShaderLib.standard.vertexShader).toContain("#include <beginnormal_vertex>");
    expect(ShaderLib.standard.fragmentShader).toContain("#include <common>");
    expect(ShaderLib.standard.fragmentShader).toContain("#include <color_fragment>");
  });

  it("declares the geometry and instance attributes used by the render layer", () => {
    for (const attribute of [
      WILDLIFE_PART_ID_ATTRIBUTE,
      WILDLIFE_PART_PIVOT_ATTRIBUTE,
      WILDLIFE_PART_AXIS_ATTRIBUTE,
      WILDLIFE_PART_ANGLES_ATTRIBUTE_0,
      WILDLIFE_PART_ANGLES_ATTRIBUTE_1,
    ]) {
      expect(WILDLIFE_PART_VERTEX_PRELUDE).toContain(`attribute`);
      expect(WILDLIFE_PART_VERTEX_PRELUDE).toContain(attribute);
    }
    // Two vec4 attributes cover exactly the 8 angle slots.
    expect(WILDLIFE_PART_ANGLE_SLOTS).toBe(8);
  });

  it("patches the standard vertex shader after each anchor, in declaration order", () => {
    const injected = injectWildlifePartVertexShader(ShaderLib.standard.vertexShader);
    const prelude = injected.indexOf("wildlifeRotateAboutAxis");
    const normalPatch = injected.indexOf("wildlifeNormalAngle");
    const positionPatch = injected.indexOf("wildlifePositionAngle");
    expect(prelude).toBeGreaterThan(-1);
    expect(normalPatch).toBeGreaterThan(prelude); // helpers first
    expect(positionPatch).toBeGreaterThan(normalPatch); // beginnormal before begin_vertex
    expect(injected).toContain("transformed = aPartPivot + wildlifeRotateAboutAxis(transformed - aPartPivot");
    expect(injected).toContain("objectNormal = wildlifeRotateAboutAxis(objectNormal");
  });

  it("patches the depth shader position path for animated shadows", () => {
    const injected = injectWildlifePartVertexShader(ShaderLib.depth.vertexShader);
    expect(injected).toContain("wildlifePositionAngle");
    expect(injected.indexOf("wildlifeRotateAboutAxis")).toBeGreaterThan(-1);
  });

  it("forwards the slot-7 shade varying from the position chunk", () => {
    const injected = injectWildlifePartVertexShader(ShaderLib.standard.vertexShader);
    expect(injected).toContain("varying float vWildlifeShade");
    expect(injected).toContain("vWildlifeShade = aPartAngles1.w");
  });

  it("is a no-op on sources without anchors instead of corrupting them", () => {
    expect(injectWildlifePartVertexShader("void main() {}")).toBe("void main() {}");
    expect(injectWildlifePartFragmentShader("void main() {}")).toBe("void main() {}");
  });
});

describe("wildlife part fragment shader injection", () => {
  it("applies the per-agent shade to the albedo after color_fragment", () => {
    const injected = injectWildlifePartFragmentShader(ShaderLib.standard.fragmentShader);
    const varyingDecl = injected.indexOf("varying float vWildlifeShade");
    const shade = injected.indexOf("diffuseColor.rgb *= (0.85 + 0.27 * vWildlifeShade)");
    const colorAnchor = injected.indexOf("#include <color_fragment>");
    expect(varyingDecl).toBeGreaterThan(-1);
    expect(shade).toBeGreaterThan(colorAnchor); // shade applies after base color
    expect(varyingDecl).toBeLessThan(shade); // declaration precedes use
  });
});

describe("wildlife part materials", () => {
  it("creates a tinted standard material with a stable shared program key", () => {
    const material = createWildlifePartMaterial(0x8a6240);
    expect(material.color.getHex()).toBe(new Color(0x8a6240).getHex());
    expect(material.roughness).toBeCloseTo(0.9, 6);
    const shader = fakeShader(ShaderLib.standard.vertexShader, ShaderLib.standard.fragmentShader);
    material.onBeforeCompile(shader, undefined as never);
    expect(shader.vertexShader).toContain("wildlifePartAngleRad");
    expect(shader.fragmentShader).toContain("vWildlifeShade");
    const other = createWildlifePartMaterial(0x5a5f66);
    expect(material.customProgramCacheKey()).toBe(other.customProgramCacheKey()); // one program for all herds
    material.dispose();
    other.dispose();
  });

  it("creates a matching depth material for the shadow pass", () => {
    const material = createWildlifePartDepthMaterial();
    expect(material.depthPacking).toBe(RGBADepthPacking);
    const shader = fakeShader(ShaderLib.depth.vertexShader);
    material.onBeforeCompile(shader, undefined as never);
    expect(shader.vertexShader).toContain("wildlifePositionAngle");
    material.dispose();
  });
});
