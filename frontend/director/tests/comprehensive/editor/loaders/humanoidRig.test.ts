import { detectHumanoidRig } from "../../../../src/comprehensive/editor/loaders/humanoidRig";

it("recognizes a Mixamo-style humanoid skeleton", () => {
  expect(detectHumanoidRig(["Hips", "Spine", "Head", "LeftArm", "RightArm", "LeftUpLeg", "RightUpLeg"])).toBe("mixamo");
});

it("recognizes namespaced Mixamo variants from FBX importers", () => {
  expect(detectHumanoidRig(["mixamorig7:Hips", "mixamorig7:Spine", "mixamorig7:Head"])).toBe("mixamo");
  expect(detectHumanoidRig(["Armature|mixamorig_12_Hips", "mixamorig_12_Spine", "mixamorig_12_Head"])).toBe("mixamo");
});
