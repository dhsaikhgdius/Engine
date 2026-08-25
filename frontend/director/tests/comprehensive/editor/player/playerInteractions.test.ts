import { expect, it } from "vitest";
import { selectNearestPlayerInteraction, type PlayerInteractionCandidate } from "../../../../src/comprehensive/editor/player/playerInteractions";

const candidates: PlayerInteractionCandidate[] = [
  { id: "far-door", position: [4, 0, 0], prompt: "打开远门", radiusM: 5 },
  { id: "near-door", position: [1.5, 0, 0], prompt: "打开近门", radiusM: 3 },
];

it("selects the nearest interaction inside its radius", () => {
  expect(selectNearestPlayerInteraction(candidates, [0, 0, 0])?.id).toBe("near-door");
});

it("ignores candidates outside the planar or vertical interaction range", () => {
  expect(selectNearestPlayerInteraction(candidates, [20, 0, 0])).toBeNull();
  expect(
    selectNearestPlayerInteraction([{ ...candidates[1]!, position: [1, 8, 0] }], [0, 0, 0]),
  ).toBeNull();
});

it("breaks equal-distance ties by id for deterministic prompts", () => {
  const tied: PlayerInteractionCandidate[] = [
    { id: "door-b", position: [1, 0, 0], prompt: "B", radiusM: 2 },
    { id: "door-a", position: [-1, 0, 0], prompt: "A", radiusM: 2 },
  ];
  expect(selectNearestPlayerInteraction(tied, [0, 0, 0])?.id).toBe("door-a");
});
