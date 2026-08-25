import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LanguageProvider } from "../../../../src/comprehensive/i18n/language";
import { CollapsedRightPanelSash } from "../../../../src/comprehensive/app/layout/CollapsedRightPanelSash";
import { MIN_RIGHT_PANEL_WIDTH } from "../../../../src/comprehensive/app/layout/workspaceLayout";

function renderSash(onExpand = vi.fn()) {
  render(
    <LanguageProvider>
      <CollapsedRightPanelSash leftPanelWidth={220} restoredWidth={260} onExpand={onExpand} />
    </LanguageProvider>,
  );
  return { onExpand, sash: screen.getByRole("separator", { name: "展开右侧栏" }) };
}

it("restores the previous inspector width from a click on the sash", () => {
  const { onExpand, sash } = renderSash();

  fireEvent.pointerDown(sash, { button: 0, clientX: 1200 });
  fireEvent.pointerUp(window, { clientX: 1200 });

  expect(onExpand).toHaveBeenCalledWith(260);
});

it("pulls the right panel open to the dragged width", () => {
  const { onExpand, sash } = renderSash();

  fireEvent.pointerDown(sash, { button: 0, clientX: 1280 });
  fireEvent.pointerMove(window, { clientX: 1280 - 320 });
  fireEvent.pointerUp(window, { clientX: 1280 - 320 });

  expect(onExpand).toHaveBeenCalled();
  expect(onExpand.mock.calls.at(-1)?.[0]).toBe(320);
});

it("does not open narrower than the inspector minimum while pulling", () => {
  const { onExpand, sash } = renderSash();

  fireEvent.pointerDown(sash, { button: 0, clientX: 1280 });
  fireEvent.pointerMove(window, { clientX: 1280 - 40 });
  fireEvent.pointerUp(window, { clientX: 1280 - 40 });

  expect(onExpand.mock.calls.at(-1)?.[0]).toBe(MIN_RIGHT_PANEL_WIDTH);
});
