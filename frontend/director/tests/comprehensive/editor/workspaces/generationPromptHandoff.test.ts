import { beforeEach, expect, it, vi } from "vitest";
import {
  consumeDirectorGenerationPromptHandoff,
  peekDirectorGenerationPromptHandoff,
  saveDirectorGenerationPromptHandoff,
} from "../../../../src/comprehensive/editor/workspaces/generationPromptHandoff";

beforeEach(() => window.sessionStorage.clear());

it("hands a bounded prompt to Gallery exactly once", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
  expect(
    saveDirectorGenerationPromptHandoff({
      mediaKind: "video",
      targetModel: "wan",
      prompt: "A measured dolly-in.",
      negativePrompt: "flicker",
      metadata: { preset: "night", seed: 7 },
    }),
  ).toBe(true);
  expect(peekDirectorGenerationPromptHandoff()).toMatchObject({
    createdAt: "2026-08-07T12:00:00.000Z",
    mediaKind: "video",
    prompt: "A measured dolly-in.",
  });
  expect(consumeDirectorGenerationPromptHandoff()?.negativePrompt).toBe("flicker");
  expect(consumeDirectorGenerationPromptHandoff()).toBeNull();
  vi.useRealTimers();
});

it("preserves a Storyboard source identity for Gallery promotion lineage", () => {
  expect(
    saveDirectorGenerationPromptHandoff({
      source: "storyboard",
      mediaKind: "image",
      targetModel: "generic",
      prompt: "Wide opening shot",
      negativePrompt: "broken continuity",
      metadata: { shotId: "shot-opening", shotTitle: "Opening", frameStart: 0 },
    }),
  ).toBe(true);
  expect(consumeDirectorGenerationPromptHandoff()).toMatchObject({
    source: "storyboard",
    mediaKind: "image",
    metadata: { shotId: "shot-opening", frameStart: 0 },
  });
});
