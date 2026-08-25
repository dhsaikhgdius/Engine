import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { DirectorObjectPbrMaterial } from "../../../../src/comprehensive/editor/canvas/DirectorPbrMaterial";

const object = {
  id: "material-test",
  name: "材质测试",
  kind: "prop" as const,
  visible: true,
  locked: false,
  color: "#abcdef",
  transform: {
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  },
};

it("uses standard PBR for metal/rough surfaces and physical PBR for transmission", () => {
  const { container, rerender } = render(<DirectorObjectPbrMaterial assets={[]} object={object} />);
  expect(container.querySelector("meshstandardmaterial")).toHaveAttribute("color", "#abcdef");

  rerender(
    <DirectorObjectPbrMaterial assets={[]} object={{ ...object, material: { transmission: 0.9, ior: 1.45 } }} />,
  );
  expect(container.querySelector("meshphysicalmaterial")).toHaveAttribute("transmission", "0.9");
  expect(container.querySelector("meshphysicalmaterial")).toHaveAttribute("ior", "1.45");
});
