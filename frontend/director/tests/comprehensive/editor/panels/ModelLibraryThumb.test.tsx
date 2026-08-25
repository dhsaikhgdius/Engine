import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ModelLibraryThumb } from "../../../../src/comprehensive/editor/panels/ModelLibraryThumb";

it("prefers webp thumbnails and falls back to svg when webp is missing", () => {
  render(<ModelLibraryThumb thumbnailUrl="/flick-stage-props/thumbnails/animals/cat.webp" />);

  const image = screen.getByRole("presentation", { hidden: true });
  expect(image).toHaveAttribute("src", "/flick-stage-props/thumbnails/animals/cat.webp");

  fireEvent.error(image);
  expect(image).toHaveAttribute("src", "/flick-stage-props/thumbnails/animals/cat.svg");
});

it("keeps a working webp thumbnail without falling back", () => {
  render(<ModelLibraryThumb thumbnailUrl="/flick-stage-props/thumbnails/animals/betta_fish.webp" />);

  const image = screen.getByRole("presentation", { hidden: true });
  expect(image).toHaveAttribute("src", "/flick-stage-props/thumbnails/animals/betta_fish.webp");

  fireEvent.load(image);
  expect(image).toHaveAttribute("src", "/flick-stage-props/thumbnails/animals/betta_fish.webp");
});

it("shows the generic fallback icon when both webp and svg fail", () => {
  const { container } = render(<ModelLibraryThumb thumbnailUrl="/flick-stage-props/thumbnails/animals/cat.webp" />);

  const image = screen.getByRole("presentation", { hidden: true });
  fireEvent.error(image);
  fireEvent.error(image);

  expect(container.querySelector("img.model-library-thumb-image")).not.toBeInTheDocument();
  expect(container.querySelector("svg.lucide-boxes")).toBeInTheDocument();
});
