import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useEscapeLayer } from "../app/layout/escapeLayerStack";

/**
 * Manages open/close state for a dropdown menu.
 *
 * Provides outside-click dismissal, Escape-key handling through the shared
 * layer stack (so a dropdown inside a modal closes before the modal), and
 * keyboard navigation on the trigger button.
 *
 * @returns Ref objects for the dropdown container, optional trigger, and optional
 *          portaled layer, a keyboard handler for the trigger, and the open state.
 */
export function useDropdownDisclosure() {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  /** Optional: attach to the trigger button so Escape/selection can restore its focus. */
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Optional: portaled menu layer; clicks inside it must not count as outside. */
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const closeOutside = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (dropdownRef.current?.contains(target) || layerRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [isOpen]);

  // Escape goes through the shared layer stack: a dropdown opened inside a
  // modal dialog registers above the dialog, so Esc closes only the dropdown.
  useEscapeLayer(isOpen, () => {
    setIsOpen(false);
    focusDropdownTrigger();
  });

  function focusDropdownTrigger() {
    const trigger = triggerRef.current ?? dropdownRef.current?.querySelector<HTMLElement>("[aria-haspopup]");
    trigger?.focus();
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setIsOpen(true);
    }
  };

  return { dropdownRef, triggerRef, layerRef, handleTriggerKeyDown, isOpen, setIsOpen };
}