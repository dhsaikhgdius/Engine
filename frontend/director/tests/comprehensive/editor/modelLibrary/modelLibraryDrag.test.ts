import { expect, it, vi } from "vitest";
import { createModelLibraryDragPayload, parseModelLibraryDragData, setModelLibraryDragData } from "../../../../src/comprehensive/editor/modelLibrary/modelLibraryDrag";

const cat = {
  assetSource: "library" as const,
  categoryId: "flick" as const,
  catalogCategory: "animals",
  fileName: "cat.glb",
  flickCategory: "animals" as const,
  id: "flick:animals:cat.glb",
  kind: "prop" as const,
  name: "Cat",
  url: "/flick-stage-props/animals/cat.glb",
};

it("hides the browser drag ghost so light library cards do not leave a white rectangle", () => {
  const setDragImage = vi.fn();
  const dataTransfer = {
    effectAllowed: "none",
    setData: vi.fn(),
    setDragImage,
  } as unknown as DataTransfer;

  setModelLibraryDragData({ dataTransfer } as Parameters<typeof setModelLibraryDragData>[0], cat);

  expect(setDragImage).toHaveBeenCalledTimes(1);
  expect(setDragImage.mock.calls[0]?.[1]).toBe(0);
  expect(setDragImage.mock.calls[0]?.[2]).toBe(0);
});

it("round-trips a trusted model-library drag payload with its catalog metric size", () => {
  expect(parseModelLibraryDragData(JSON.stringify(createModelLibraryDragPayload(cat)))).toEqual({
    type: "director-model-library-asset",
    id: cat.id,
    kind: "prop",
    name: "Cat",
    fileName: "cat.glb",
    url: cat.url,
    assetSource: "library",
    realWorldSizeM: 0.6,
  });
});

it("rejects payloads carrying a non-positive real-world size", () => {
  expect(
    parseModelLibraryDragData(JSON.stringify({ ...createModelLibraryDragPayload(cat), realWorldSizeM: -1 })),
  ).toBeNull();
});

it("rejects malformed or unsupported model-library drag payloads", () => {
  expect(parseModelLibraryDragData("not-json")).toBeNull();
  expect(
    parseModelLibraryDragData(
      JSON.stringify({
        type: "director-model-library-asset",
        id: cat.id,
        name: cat.name,
        fileName: cat.fileName,
        url: cat.url,
        nativeAction: "delete-all",
      }),
    ),
  ).toBeNull();
});

it("round-trips validated Mixamo placement and rig metadata", () => {
  const character = {
    assetSource: "library" as const,
    categoryId: "flick" as const,
    catalogCategory: "characters",
    characterMetadata: {
      heightM: 1.78,
      groundOffsetY: 0,
      visualCenter: [0, 0.89, 0] as [number, number, number],
      labelAnchorY: 1.9,
      rig: { type: "mixamo" as const, boneCount: 65, bonePrefix: "mixamorig" },
    },
    fileName: "Standing Idle.fbx",
    flickCategory: "characters" as const,
    id: "director:hero",
    kind: "character" as const,
    name: "Hero",
    url: "/director-characters/models/Standing%20Idle.fbx",
  };

  const parsed = parseModelLibraryDragData(JSON.stringify(createModelLibraryDragPayload(character)));

  expect(parsed).toMatchObject({
    id: "director:hero",
    kind: "character",
    characterMetadata: character.characterMetadata,
  });
  expect(
    parseModelLibraryDragData(
      JSON.stringify({
        ...createModelLibraryDragPayload(character),
        characterMetadata: { ...character.characterMetadata, heightM: Number.NaN },
      }),
    ),
  ).toBeNull();
});
