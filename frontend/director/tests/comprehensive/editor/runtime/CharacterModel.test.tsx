import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CharacterModel,
  getDefaultDirectorCharacterUrl,
} from "../../../../src/comprehensive/editor/runtime/CharacterModel";

vi.mock("../../../../src/comprehensive/editor/runtime/MixamoCharacterModel", () => ({
  MixamoCharacterModel: ({
    bodyType,
    runtimeControlled,
    url,
  }: {
    bodyType?: string;
    runtimeControlled?: boolean;
    url: string;
  }) => (
    <div
      data-testid="mixamo-character"
      data-body-type={bodyType ?? ""}
      data-runtime-controlled={runtimeControlled ? "true" : "false"}
      data-url={url}
    />
  ),
}));

describe("CharacterModel", () => {
  it("renders the bundled hero for the default mannequin body type", () => {
    const { getByTestId } = render(<CharacterModel bodyType="mannequin" />);
    expect(getByTestId("mixamo-character")).toHaveAttribute("data-url", "/mixamo-characters/models/x-bot.glb");
    expect(getDefaultDirectorCharacterUrl("mannequin")).toBe("/mixamo-characters/models/x-bot.glb");
  });

  it("falls back to the bundled hero for every body type", () => {
    const { getByTestId, rerender } = render(<CharacterModel bodyType="female" />);
    expect(getByTestId("mixamo-character")).toHaveAttribute("data-url", getDefaultDirectorCharacterUrl("female"));

    rerender(<CharacterModel bodyType="chibi" />);
    expect(getByTestId("mixamo-character")).toHaveAttribute("data-url", getDefaultDirectorCharacterUrl("chibi"));
  });

  it("only opts the active player into the per-frame locomotion runtime", () => {
    const { getByTestId, rerender } = render(<CharacterModel bodyType="mannequin" />);
    expect(getByTestId("mixamo-character")).toHaveAttribute("data-runtime-controlled", "false");

    rerender(<CharacterModel bodyType="mannequin" runtimeControlled />);
    expect(getByTestId("mixamo-character")).toHaveAttribute("data-runtime-controlled", "true");
  });
});
