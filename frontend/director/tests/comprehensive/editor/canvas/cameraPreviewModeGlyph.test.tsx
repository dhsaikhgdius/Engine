import { render } from "@testing-library/react";
import { DIRECTOR_CAMERA_PREVIEW_MODES } from "../../../../src/comprehensive/editor/render/cameraPreviewModality";
import { CameraPreviewModeGlyph } from "../../../../src/comprehensive/editor/canvas/cameraPreviewModeGlyph";

it("renders a distinct isometric glyph for every camera monitor modality", () => {
  const { container, rerender } = render(<CameraPreviewModeGlyph mode="previz" />);
  const marks = new Set<string>();

  for (const mode of DIRECTOR_CAMERA_PREVIEW_MODES) {
    rerender(<CameraPreviewModeGlyph mode={mode} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-preview-mode", mode);
    expect(svg?.querySelector("path")).not.toBeNull();
    marks.add(svg?.innerHTML ?? "");
  }

  expect(marks.size).toBe(DIRECTOR_CAMERA_PREVIEW_MODES.length);
});
