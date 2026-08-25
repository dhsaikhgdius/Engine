/**
 * 创意传输控件下拉菜单，通过 Portal 渲染到 body，支持键盘导航和选中状态。
 *
 * @module creative-transport-dropdown
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

/** 下拉菜单选项，包含 id、标签、禁用状态和可选图标。 */
export type CreativeTransportDropdownOption = {
  id: string;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
};

const MENU_MIN_WIDTH = 120;
const MENU_GAP = 6;

function getEnabledOptionButtons(menu: HTMLElement | null): HTMLButtonElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLButtonElement>(".creative-transport-dropdown-option")).filter(
    (button) => !button.disabled,
  );
}

function getMenuStyle(trigger: HTMLElement, align: "left" | "right"): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  return {
    position: "fixed",
    bottom: window.innerHeight - rect.top + MENU_GAP,
    left: align === "right" ? undefined : rect.left,
    right: align === "right" ? window.innerWidth - rect.right : undefined,
    minWidth: Math.max(rect.width, MENU_MIN_WIDTH),
    zIndex: 80,
  };
}

/**
 * 渲染一个自定义下拉菜单，通过 createPortal 渲染到 body，支持键盘导航。
 * @param ariaLabel - 无障碍标签。
 * @param trigger - 触发器内容。
 * @param options - 选项列表。
 * @param value - 当前选中值（可选）。
 * @param onSelect - 选中回调。
 * @param align - 菜单对齐方式，默认 "left"。
 */
export function CreativeTransportDropdown({
  ariaLabel,
  trigger,
  options,
  value,
  onSelect,
  align = "left",
}: {
  ariaLabel: string;
  trigger: ReactNode;
  options: CreativeTransportDropdownOption[];
  value?: string;
  onSelect: (id: string) => void;
  align?: "left" | "right";
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuPosition = useCallback(() => {
    if (!triggerRef.current) return;
    setMenuStyle(getMenuStyle(triggerRef.current, align));
  }, [align]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const buttons = getEnabledOptionButtons(menuRef.current);
    const selected = buttons.find((button) => button.classList.contains("is-selected"));
    (selected ?? buttons[0])?.focus();
  }, [isOpen]);

  function selectOption(option: CreativeTransportDropdownOption) {
    if (option.disabled) return;
    onSelect(option.id);
    setIsOpen(false);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setIsOpen(true);
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      setIsOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const optionId = (event.target as HTMLElement).closest("button")?.dataset.optionId;
      const option = options.find((candidate) => candidate.id === optionId);
      if (option) {
        event.preventDefault();
        selectOption(option);
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const buttons = getEnabledOptionButtons(menuRef.current);
    if (buttons.length === 0) return;
    event.preventDefault();
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = buttons.length - 1;
    else if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % buttons.length;
    else nextIndex = currentIndex < 0 ? buttons.length - 1 : (currentIndex - 1 + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  const menuRole = value === undefined ? "menu" : "listbox";
  const menu =
    isOpen && typeof document !== "undefined" ? (
      <div
        aria-label={ariaLabel}
        className="creative-transport-dropdown-menu is-portaled"
        onKeyDown={handleMenuKeyDown}
        ref={menuRef}
        role={menuRole}
        style={menuStyle}
      >
        {options.map((option) => {
          const isSelected = value !== undefined && option.id === value;

          return (
            <button
              aria-selected={value !== undefined ? isSelected : undefined}
              className={`creative-transport-dropdown-option${isSelected ? " is-selected" : ""}`}
              data-option-id={option.id}
              disabled={option.disabled}
              key={option.id}
              role={value === undefined ? "menuitem" : "option"}
              type="button"
              onClick={() => selectOption(option)}
            >
              {option.icon ? <span className="creative-transport-dropdown-option-icon">{option.icon}</span> : null}
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <div className="creative-transport-dropdown" ref={rootRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup={menuRole}
        aria-label={ariaLabel}
        className={`creative-transport-dropdown-trigger${isOpen ? " is-open" : ""}`}
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <span className="creative-transport-dropdown-label">{trigger}</span>
        <ChevronDown aria-hidden className="creative-transport-dropdown-chevron" size={12} strokeWidth={2} />
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
