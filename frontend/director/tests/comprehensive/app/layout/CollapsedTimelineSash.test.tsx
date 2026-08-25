import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LanguageProvider } from "../../../../src/comprehensive/i18n/language";
import { CollapsedTimelineSash } from "../../../../src/comprehensive/app/layout/CollapsedTimelineSash";
import { MIN_TIMELINE_HEIGHT } from "../../../../src/comprehensive/app/layout/workspaceLayout";

function renderSash(onExpand = vi.fn()) {
  render(
    <LanguageProvider>
      <CollapsedTimelineSash restoredHeight={238} onExpand={onExpand} />
    </LanguageProvider>,
  );
  return { onExpand, sash: screen.getByRole("separator", { name: "展开下方栏" }) };
}

it("restores the previous bottom-panel height from a click on the sash", () => {
  const { onExpand, sash } = renderSash();

  fireEvent.pointerDown(sash, { button: 0, clientY: 800 });
  fireEvent.pointerUp(window, { clientY: 800 });

  expect(onExpand).toHaveBeenCalledWith(238);
});

it("pulls the bottom panel open to the dragged height", () => {
  const { onExpand, sash } = renderSash();

  fireEvent.pointerDown(sash, { button: 0, clientY: 900 });
  fireEvent.pointerMove(window, { clientY: 900 - 260 });
  fireEvent.pointerUp(window, { clientY: 900 - 260 });

  expect(onExpand).toHaveBeenCalled();
  expect(onExpand.mock.calls.at(-1)?.[0]).toBe(260);
});

it("does not open shorter than the timeline minimum while pulling", () => {
  const { onExpand, sash } = renderSash();

  fireEvent.pointerDown(sash, { button: 0, clientY: 900 });
  fireEvent.pointerMove(window, { clientY: 900 - 40 });
  fireEvent.pointerUp(window, { clientY: 900 - 40 });

  expect(onExpand.mock.calls.at(-1)?.[0]).toBe(MIN_TIMELINE_HEIGHT);
});
