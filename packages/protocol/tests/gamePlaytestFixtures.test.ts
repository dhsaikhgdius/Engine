import { describe, expect, it } from "vitest";
import { evaluateGamePlaytest } from "../src/directorGameMachine";
import {
  createGenrePlaytestFixture,
  GAME_SLICE_GENRES,
  suggestedPlaytestScriptForSlice,
} from "../src/gamePlaytestFixtures";
import { runHostFreeGamePlaytest } from "../src/gamePlaytestHostFree";

describe("gamePlaytestFixtures", () => {
  for (const genre of GAME_SLICE_GENRES) {
    it(`scores ${genre} playable with the host-free genre tape`, () => {
      const { slice, script } = createGenrePlaytestFixture(genre);
      const trace = runHostFreeGamePlaytest({ slice, script });
      const report = evaluateGamePlaytest(slice, trace);
      expect(report.playable, JSON.stringify(report.issues)).toBe(true);
      for (const verb of slice.acceptance.operations) {
        expect(report.verbs_exercised).toContain(verb);
      }
    });
  }

  it("suggests a script matching acceptance operations", () => {
    const { slice } = createGenrePlaytestFixture("exploration");
    const suggested = suggestedPlaytestScriptForSlice(slice);
    expect(suggested.steps.length).toBe(slice.acceptance.operations.length);
  });
});
