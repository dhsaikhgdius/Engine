import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { CreativeMediaWaveformData } from "../../../../src/comprehensive/editor/media/creativeMediaEngineering";
import {
  buildCreativeMediaWaveformPath,
  CreativeMediaWaveform,
} from "../../../../src/comprehensive/editor/workspaces/CreativeMediaWaveform";

const WAVEFORM: CreativeMediaWaveformData = {
  version: 1,
  durationSec: 4,
  sampleRate: 48_000,
  channelCount: 1,
  samplesPerPeak: 24_000,
  minPeaks: [-0.25, -0.5, -0.75, -1, -0.8, -0.6, -0.4, -0.2],
  maxPeaks: [0.2, 0.4, 0.6, 0.8, 1, 0.75, 0.5, 0.25],
};

it("builds the visible waveform from the trimmed source-time window", () => {
  const full = buildCreativeMediaWaveformPath(WAVEFORM, { inSec: 0, durationSec: 4, playbackRate: 1 });
  const trimmed = buildCreativeMediaWaveformPath(WAVEFORM, { inSec: 1, durationSec: 1, playbackRate: 2 });

  expect(full).toMatch(/^M /);
  expect(full).toContain("120.00");
  expect(trimmed).toMatch(/^M /);
  expect(trimmed).not.toBe(full);
});

it("keeps a one-peak source range visible across the clip width", () => {
  const path = buildCreativeMediaWaveformPath(WAVEFORM, { inSec: 3.9, durationSec: 0.05, playbackRate: 1 });

  expect(path).toContain("0.00");
  expect(path).toContain("120.00");
});

it("rejects invalid source windows and renders an accessible SVG for valid data", () => {
  expect(buildCreativeMediaWaveformPath(WAVEFORM, { inSec: 0, durationSec: 0, playbackRate: 1 })).toBe("");
  expect(buildCreativeMediaWaveformPath(WAVEFORM, { inSec: 0, durationSec: 1, playbackRate: Number.NaN })).toBe("");

  render(
    <CreativeMediaWaveform
      label="Dialogue audio waveform"
      waveform={WAVEFORM}
      window={{ inSec: 0.5, durationSec: 2, playbackRate: 1 }}
    />,
  );
  const graphic = screen.getByRole("img", { name: "Dialogue audio waveform" });
  expect(graphic).toHaveAttribute("viewBox", "0 0 120 40");
  expect(graphic.querySelector("path")).toHaveAttribute("d", expect.stringMatching(/^M /));
});
