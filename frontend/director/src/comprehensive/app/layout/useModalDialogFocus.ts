import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { registerEscapeLayer } from "./escapeLayerStack";

/**
 * CSS selector that matches every element that can receive keyboard focus
 * and is not explicitly disabled or hidden.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * Collects every focusable element inside a container, excluding ones inside
 * `[hidden]` ancestors or marked `aria-hidden="true"`.
 *
 * @param container - The element to search within.
 * @returns An array of focusable HTMLElements in DOM order.
 */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.closest("[hidden]") && element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Shared focus contract for modal dialogs:
 * - on open, focus moves to `initialFocusRef` or the first focusable control;
 * - Tab / Shift+Tab cycle inside the dialog (focus trap);
 * - Escape closes through the escape layer stack (top layer wins);
 * - on close, focus returns to whatever was focused before the dialog opened.
 *
 * Attach the returned ref to the element that carries `role="dialog"`.
 *
 * @param options.enabled - Set false while the dialog markup is not rendered
 *   (conditional dialogs inside a panel).
 * @param options.initialFocusRef - Focused on open instead of the first focusable control.
 * @param options.onClose - Called when the dialog should close (Escape or external trigger).
 * @returns A ref to attach to the dialog container element.
 */
export function useModalDialogFocus<T extends HTMLElement>({
  enabled = true,
  initialFocusRef,
  onClose,
}: {
  enabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const containerRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const initialFocusOptionRef = useRef(initialFocusRef);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    initialFocusOptionRef.current = initialFocusRef;
  });

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Fallback focus target when the dialog has no focusable children yet.
    if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
    const initial = initialFocusOptionRef.current?.current ?? getFocusableElements(container)[0] ?? container;
    initial.focus();

    const releaseEscapeLayer = registerEscapeLayer(() => onCloseRef.current());

    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      const activeInside = active instanceof HTMLElement && container.contains(active);
      if (event.shiftKey) {
        if (!activeInside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!activeInside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapTab);

    return () => {
      document.removeEventListener("keydown", trapTab);
      releaseEscapeLayer();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [enabled]);

  return containerRef;
}
