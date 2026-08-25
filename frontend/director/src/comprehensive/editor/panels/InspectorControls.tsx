/**
 * 检查器面板通用控件：面板容器、文本字段、数值字段、下拉选择、轴向量组、范围滑块和颜色选择器。
 *
 * @module inspector-controls
 */

import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { useDropdownDisclosure } from "../useDropdownDisclosure";
import { useDirectorStore } from "../store/directorStore";

type InspectorTab = {
  label: string;
  active: boolean;
  onClick: () => void;
};

type FieldValue = string | number;

type AxisControl = {
  axis: "X" | "Y" | "Z";
  ariaLabel: string;
  value: FieldValue;
  onChange: (value: string) => void;
  step?: string;
  min?: string;
  max?: string;
};

type TextFieldProps = {
  label: string;
  ariaLabel: string;
  value: FieldValue;
  onChange: (value: string) => void;
  type?: "text" | "number";
  step?: string;
  min?: string;
  max?: string;
};

type RangeNumberFieldProps = {
  label: string;
  rangeAriaLabel: string;
  numberAriaLabel: string;
  value: FieldValue;
  onValueChange: (value: string) => void;
  onRangeChange?: (value: string) => void;
  onNumberChange?: (value: string) => void;
  onNumberBlur?: (value: string) => void;
  min: string | number;
  max: string | number;
  step: string | number;
};

type InspectorSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type OptionElementProps = {
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
};

const AXIS_DRAG_PIXELS_PER_STEP = 10;
const AXIS_DISPLAY_DECIMALS = 3;

function parseFiniteNumber(value: FieldValue | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStep(step: string | undefined) {
  const parsed = parseFiniteNumber(step);
  return parsed && parsed > 0 ? parsed : 1;
}

function decimalPlaces(value: FieldValue | undefined) {
  const stringValue = String(value ?? "");
  const decimal = stringValue.match(/\.(\d+)/);
  return decimal ? decimal[1].length : 0;
}

function clampValue(value: number, min?: string, max?: string) {
  const parsedMin = parseFiniteNumber(min);
  const parsedMax = parseFiniteNumber(max);
  const lowerBounded = parsedMin === null ? value : Math.max(parsedMin, value);
  return parsedMax === null ? lowerBounded : Math.min(parsedMax, lowerBounded);
}

function formatDraggedValue(value: number, precision: number) {
  return Number(value.toFixed(Math.min(precision, 6))).toString();
}

/* Transforms carry full float precision in the store; the field only ever needs
 * millimetre/millidegree resolution, and raw floats overflow the input. */
function formatAxisDisplayValue(value: FieldValue) {
  const parsed = parseFiniteNumber(value);
  return parsed === null ? String(value ?? "") : Number(parsed.toFixed(AXIS_DISPLAY_DECIMALS)).toString();
}

function stringifyOptionLabel(children: ReactNode) {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("")
    .trim();
}

function parseSelectOptions(children: ReactNode): InspectorSelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<OptionElementProps>(child)) return [];

    const optionValue = child.props.value;
    if (optionValue === undefined || optionValue === null) return [];

    return [
      {
        value: String(optionValue),
        label: stringifyOptionLabel(child.props.children) || String(optionValue),
        disabled: child.props.disabled,
      },
    ];
  });
}

function getEnabledOptionButtons(menu: HTMLElement | null): HTMLButtonElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLButtonElement>(".inspector-dropdown-option")).filter(
    (button) => !button.disabled,
  );
}

function useUndoBatchInteraction() {
  const beginUndoBatch = useDirectorStore((state) => state.beginUndoBatch);
  const endUndoBatch = useDirectorStore((state) => state.endUndoBatch);
  const isBatchActiveRef = useRef(false);

  const beginInteraction = useCallback(() => {
    if (isBatchActiveRef.current) return;

    isBatchActiveRef.current = true;
    beginUndoBatch();
  }, [beginUndoBatch]);

  const endInteraction = useCallback(() => {
    if (!isBatchActiveRef.current) return;

    isBatchActiveRef.current = false;
    endUndoBatch();
  }, [endUndoBatch]);

  useEffect(() => endInteraction, [endInteraction]);

  return { beginInteraction, endInteraction };
}

/**
 * 检查器面板容器，包含标题、可选标签页和内容区域。
 * @param title - 面板标题。
 * @param ariaLabel - 无障碍标签。
 * @param tabs - 可选的标签页配置。
 * @param className - 可选的 CSS 类名。
 * @param children - 面板内容。
 * @param footer - 可选的面板底部内容。
 */
export function InspectorPanel({
  title,
  ariaLabel,
  tabs,
  className,
  children,
  footer,
}: {
  title: string;
  ariaLabel: string;
  tabs?: InspectorTab[];
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className={`panel-card right-inspector${className ? ` ${className}` : ""}`} aria-label={ariaLabel}>
      <header className="right-inspector-header">
        <h2 className="right-inspector-title">{title}</h2>
      </header>
      {tabs ? (
        <div className="tab-row right-inspector-tabs" role="tablist" aria-label={`${title}面板标签`}>
          {tabs.map((tab) => (
            <button
              key={tab.label}
              className="right-inspector-tab-button"
              type="button"
              aria-pressed={tab.active}
              onClick={tab.onClick}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className={`right-inspector-content ${tabs ? "" : "right-inspector-content-no-tabs"}`}>{children}</div>
      {footer}
    </section>
  );
}

/**
 * 检查器文本字段，支持文本和数字输入类型。
 * @param label - 字段标签。
 * @param ariaLabel - 输入框的无障碍标签。
 * @param value - 当前字段值。
 * @param onChange - 值变更回调。
 * @param type - 输入类型，默认 "text"。
 * @param step - 数字输入的步长。
 * @param min - 数字输入的最小值。
 * @param max - 数字输入的最大值。
 */
export function InspectorTextField({
  label,
  ariaLabel,
  value,
  onChange,
  type = "text",
  step,
  min,
  max,
}: TextFieldProps) {
  const { beginInteraction, endInteraction } = useUndoBatchInteraction();

  return (
    <label className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <input
        aria-label={ariaLabel}
        className="inspector-text-input"
        max={max}
        min={min}
        step={step}
        type={type}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={endInteraction}
        onFocus={beginInteraction}
      />
    </label>
  );
}

/**
 * 检查器带单位数值字段，在输入框后显示单位后缀。
 * @param label - 字段标签。
 * @param ariaLabel - 输入框的无障碍标签。
 * @param value - 当前字段值。
 * @param unit - 单位后缀字符串。
 * @param onChange - 值变更回调。
 * @param step - 步长。
 * @param min - 最小值。
 * @param max - 最大值。
 */
export function InspectorUnitNumberField({
  label,
  ariaLabel,
  value,
  unit,
  onChange,
  step,
  min,
  max,
}: {
  label: string;
  ariaLabel: string;
  value: FieldValue;
  unit: string;
  onChange: (value: string) => void;
  step?: string;
  min?: string;
  max?: string;
}) {
  const { beginInteraction, endInteraction } = useUndoBatchInteraction();

  return (
    <label className="inspector-field inspector-unit-number-field">
      <span className="inspector-field-label">{label}</span>
      <span className="inspector-unit-number-control">
        <input
          aria-label={ariaLabel}
          className="inspector-text-input"
          max={max}
          min={min}
          step={step}
          type="number"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          onBlur={endInteraction}
          onFocus={beginInteraction}
        />
        <span aria-hidden="true" className="inspector-unit-number-suffix">
          {unit}
        </span>
      </span>
    </label>
  );
}

/**
 * 检查器下拉选择字段，使用自定义下拉菜单替代原生 select。
 * @param label - 字段标签。
 * @param ariaLabel - 触发器按钮的无障碍标签。
 * @param value - 当前选中值。
 * @param onChange - 选中值变更回调。
 * @param children - 可选的 option 子元素（用于自动解析选项）。
 * @param options - 手动提供的选项列表，优先级高于 children 解析。
 */
export function InspectorSelectField({
  label,
  ariaLabel,
  value,
  onChange,
  children,
  options,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  children?: ReactNode;
  options?: InspectorSelectOption[];
}) {
  const { dropdownRef, triggerRef, handleTriggerKeyDown, isOpen, setIsOpen } = useDropdownDisclosure();
  const menuRef = useRef<HTMLDivElement>(null);
  const resolvedOptions = options ?? parseSelectOptions(children);
  const selectedOption = resolvedOptions.find((option) => option.value === value) ?? resolvedOptions[0];

  // Keyboard parity with CreativeTransportDropdown: opening moves focus onto
  // the selected option so arrow keys work immediately.
  useEffect(() => {
    if (!isOpen) return;
    const optionButtons = getEnabledOptionButtons(menuRef.current);
    const selected = optionButtons.find((button) => button.classList.contains("is-selected"));
    (selected ?? optionButtons[0])?.focus();
  }, [isOpen]);

  function selectOption(option: InspectorSelectOption) {
    if (option.disabled) return;

    onChange(option.value);
    setIsOpen(false);
    triggerRef.current?.focus();
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      setIsOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const optionValue = (event.target as HTMLElement).closest("button")?.dataset.optionValue;
      const option = resolvedOptions.find((candidate) => candidate.value === optionValue);
      if (option) {
        event.preventDefault();
        selectOption(option);
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const optionButtons = getEnabledOptionButtons(menuRef.current);
    if (optionButtons.length === 0) return;
    event.preventDefault();
    const currentIndex = optionButtons.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = optionButtons.length - 1;
    else if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % optionButtons.length;
    else {
      nextIndex =
        currentIndex < 0 ? optionButtons.length - 1 : (currentIndex - 1 + optionButtons.length) % optionButtons.length;
    }
    optionButtons[nextIndex]?.focus();
  }

  return (
    <div className="inspector-field inspector-select-field">
      <span className="inspector-field-label">{label}</span>
      <div className="inspector-dropdown" ref={dropdownRef}>
        <button
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          className="inspector-dropdown-trigger"
          ref={triggerRef}
          type="button"
          onClick={() => setIsOpen((current) => !current)}
          onKeyDown={handleTriggerKeyDown}
        >
          <span className="inspector-dropdown-value">{selectedOption?.label ?? "请选择"}</span>
          <ChevronDown aria-hidden="true" className="inspector-dropdown-chevron" strokeWidth={1.8} />
        </button>
        {isOpen ? (
          <div
            aria-label={ariaLabel}
            className="inspector-dropdown-menu"
            ref={menuRef}
            role="listbox"
            onKeyDown={handleMenuKeyDown}
          >
            {resolvedOptions.map((option) => {
              const isSelected = option.value === value;

              return (
                <button
                  aria-selected={isSelected}
                  className={`inspector-dropdown-option${isSelected ? " is-selected" : ""}`}
                  data-option-value={option.value}
                  disabled={option.disabled}
                  key={option.value}
                  role="option"
                  type="button"
                  onClick={() => selectOption(option)}
                >
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 检查器轴向量组，渲染 X/Y/Z 三个轴输入控件，支持拖拽微调。
 * @param label - 轴组标签。
 * @param axes - 三个轴的控件配置数组。
 */
export function InspectorAxisGroup({ label, axes }: { label: string; axes: AxisControl[] }) {
  return (
    <div className="inspector-field inspector-axis-group" role="group" aria-label={label}>
      <span className="inspector-field-label">{label}</span>
      <div className="inspector-axis-row">
        {axes.map((control) => (
          <InspectorAxisInput key={control.ariaLabel} control={control} />
        ))}
      </div>
    </div>
  );
}

function InspectorAxisInput({ control }: { control: AxisControl }) {
  const [isDragging, setIsDragging] = useState(false);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const { beginInteraction, endInteraction } = useUndoBatchInteraction();

  useEffect(() => () => cleanupDragRef.current?.(), []);

  function applyDeltaFromValue(deltaSteps: number, value: FieldValue) {
    const step = parseStep(control.step);
    const startValue = parseFiniteNumber(value) ?? 0;
    const precision = Math.max(decimalPlaces(control.step), decimalPlaces(value));
    const nextValue = clampValue(startValue + deltaSteps * step, control.min, control.max);
    control.onChange(formatDraggedValue(nextValue, precision));
  }

  function handlePrefixMouseDown(event: MouseEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;

    event.currentTarget.focus();
    event.preventDefault();
    event.stopPropagation();
    cleanupDragRef.current?.();
    beginInteraction();
    setIsDragging(true);

    const startX = event.clientX;
    const startValue = parseFiniteNumber(control.value) ?? 0;
    const step = parseStep(control.step);
    const precision = Math.max(decimalPlaces(control.step), decimalPlaces(control.value));
    let previousValue = formatDraggedValue(startValue, precision);

    const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
      moveEvent.preventDefault();
      const deltaSteps = Math.round((moveEvent.clientX - startX) / AXIS_DRAG_PIXELS_PER_STEP);
      const nextValue = clampValue(startValue + deltaSteps * step, control.min, control.max);
      const formattedValue = formatDraggedValue(nextValue, precision);

      if (formattedValue !== previousValue) {
        previousValue = formattedValue;
        control.onChange(formattedValue);
      }
    };

    const stopDrag = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopDrag);
      cleanupDragRef.current = null;
      setIsDragging(false);
      endInteraction();
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopDrag);
    cleanupDragRef.current = stopDrag;
  }

  function handlePrefixKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      applyDeltaFromValue(1, control.value);
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      applyDeltaFromValue(-1, control.value);
    }
  }

  return (
    <div className={`inspector-axis-input${isDragging ? " is-dragging" : ""}`}>
      <button
        aria-label={`${control.ariaLabel} 拖动调整`}
        className="inspector-axis-prefix"
        data-axis={control.axis}
        type="button"
        onKeyDown={handlePrefixKeyDown}
        onMouseDown={handlePrefixMouseDown}
      >
        {control.axis}
      </button>
      <input
        aria-label={control.ariaLabel}
        className="inspector-axis-value"
        max={control.max}
        min={control.min}
        step={control.step}
        type="number"
        value={formatAxisDisplayValue(control.value)}
        onChange={(event) => control.onChange(event.currentTarget.value)}
        onBlur={endInteraction}
        onFocus={beginInteraction}
      />
    </div>
  );
}

/**
 * 检查器范围滑块字段，同时提供滑块和数字输入两种控制方式。
 * @param label - 字段标签。
 * @param rangeAriaLabel - 滑块的无障碍标签。
 * @param numberAriaLabel - 数字输入的无障碍标签。
 * @param value - 当前值。
 * @param onValueChange - 通过滑块或数字输入变更时的回调。
 * @param onRangeChange - 仅滑块变更时的回调，会覆盖 onValueChange。
 * @param onNumberChange - 仅数字输入变更时的回调，会覆盖 onValueChange。
 * @param onNumberBlur - 数字输入失焦时的回调。
 * @param min - 最小值。
 * @param max - 最大值。
 * @param step - 步长。
 */
export function InspectorRangeNumberField({
  label,
  rangeAriaLabel,
  numberAriaLabel,
  value,
  onValueChange,
  onRangeChange,
  onNumberChange,
  onNumberBlur,
  min,
  max,
  step,
}: RangeNumberFieldProps) {
  const [draftValue, setDraftValue] = useState(() => String(value));
  const isRangeDraggingRef = useRef(false);
  const rangeDragCleanupRef = useRef<(() => void) | null>(null);
  const rafCommitRef = useRef<number | null>(null);
  const pendingCommitRef = useRef<string | null>(null);
  const { beginInteraction, endInteraction } = useUndoBatchInteraction();

  useEffect(() => {
    if (!isRangeDraggingRef.current) {
      setDraftValue(String(value));
    }
  }, [value]);

  useEffect(
    () => () => {
      if (rafCommitRef.current !== null) cancelAnimationFrame(rafCommitRef.current);
      rangeDragCleanupRef.current?.();
    },
    [],
  );

  function commitValue(nextValue: string) {
    (onRangeChange ?? onValueChange)(nextValue);
  }

  function flushPendingCommit() {
    if (rafCommitRef.current !== null) {
      cancelAnimationFrame(rafCommitRef.current);
      rafCommitRef.current = null;
    }

    if (pendingCommitRef.current === null) return;

    const nextValue = pendingCommitRef.current;
    pendingCommitRef.current = null;
    commitValue(nextValue);
  }

  function scheduleCommit(nextValue: string) {
    pendingCommitRef.current = nextValue;
    if (rafCommitRef.current !== null) return;

    rafCommitRef.current = requestAnimationFrame(() => {
      rafCommitRef.current = null;
      flushPendingCommit();
    });
  }

  function stopRangeDrag() {
    window.removeEventListener("pointerup", stopRangeDrag);
    window.removeEventListener("pointercancel", stopRangeDrag);
    rangeDragCleanupRef.current = null;
    isRangeDraggingRef.current = false;
    flushPendingCommit();
    endInteraction();
  }

  function beginRangeDrag() {
    rangeDragCleanupRef.current?.();
    isRangeDraggingRef.current = true;
    beginInteraction();
    window.addEventListener("pointerup", stopRangeDrag);
    window.addEventListener("pointercancel", stopRangeDrag);
    rangeDragCleanupRef.current = stopRangeDrag;
  }

  function handleRangeChange(nextValue: string) {
    setDraftValue(nextValue);

    if (isRangeDraggingRef.current) {
      scheduleCommit(nextValue);
      return;
    }

    commitValue(nextValue);
  }

  function handleNumberChange(nextValue: string) {
    setDraftValue(nextValue);
    (onNumberChange ?? onValueChange)(nextValue);
  }

  return (
    <div className="inspector-field inspector-range-field">
      <span className="inspector-field-label">{label}</span>
      <div className="inspector-range-row">
        <input
          aria-label={rangeAriaLabel}
          className="inspector-range"
          max={max}
          min={min}
          step={step}
          type="range"
          value={draftValue}
          onChange={(event) => handleRangeChange(event.currentTarget.value)}
          onPointerCancel={stopRangeDrag}
          onPointerDown={beginRangeDrag}
          onPointerUp={stopRangeDrag}
        />
        <input
          aria-label={numberAriaLabel}
          className="inspector-text-input inspector-range-value"
          max={max}
          min={min}
          step={step}
          type="number"
          value={draftValue}
          onBlur={(event) => {
            onNumberBlur?.(event.currentTarget.value);
            setDraftValue(event.currentTarget.value);
            endInteraction();
          }}
          onChange={(event) => handleNumberChange(event.currentTarget.value)}
          onFocus={beginInteraction}
        />
      </div>
    </div>
  );
}

/**
 * 检查器颜色字段，包含颜色取色器和十六进制文本输入。
 * @param label - 字段标签。
 * @param colorAriaLabel - 取色器的无障碍标签。
 * @param hexAriaLabel - 十六进制输入的无障碍标签。
 * @param value - 当前颜色值（十六进制字符串）。
 * @param onColorChange - 取色器变更回调。
 * @param onHexChange - 十六进制输入变更回调。
 */
export function InspectorColorField({
  label,
  colorAriaLabel,
  hexAriaLabel,
  value,
  onColorChange,
  onHexChange,
}: {
  label: string;
  colorAriaLabel: string;
  hexAriaLabel: string;
  value: string;
  onColorChange: (value: string) => void;
  onHexChange: (value: string) => void;
}) {
  const { beginInteraction, endInteraction } = useUndoBatchInteraction();

  return (
    <label className="inspector-field inspector-color-field">
      <span className="inspector-field-label">{label}</span>
      <div className="inspector-color-row">
        <input
          aria-label={colorAriaLabel}
          className="inspector-color-swatch"
          type="color"
          value={value}
          onChange={(event) => onColorChange(event.currentTarget.value)}
          onBlur={endInteraction}
          onFocus={beginInteraction}
        />
        <input
          aria-label={hexAriaLabel}
          className="inspector-text-input inspector-color-hex"
          value={value}
          onChange={(event) => onHexChange(event.currentTarget.value)}
          onBlur={endInteraction}
          onFocus={beginInteraction}
        />
      </div>
    </label>
  );
}

/**
 * 检查器分组区块，支持可折叠和描述文本。
 * @param title - 区块标题。
 * @param className - 可选的 CSS 类名。
 * @param children - 区块内容。
 * @param description - 可选的描述文本。
 * @param collapsible - 是否可折叠，默认 false。
 * @param defaultOpen - 默认是否展开，默认 true。
 */
export function InspectorSection({
  title,
  className,
  children,
  description,
  collapsible = false,
  defaultOpen = true,
}: {
  title: string;
  className?: string;
  children: ReactNode;
  description?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      className={`inspector-section${className ? ` ${className}` : ""}${collapsible && !open ? " is-collapsed" : ""}`}
    >
      <div className="inspector-section-heading">
        {collapsible ? (
          <button
            aria-expanded={open}
            className="inspector-section-toggle"
            type="button"
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown
              aria-hidden="true"
              className={`inspector-section-chevron${open ? " is-open" : ""}`}
              strokeWidth={2}
            />
            <h3>{title}</h3>
          </button>
        ) : (
          <h3>{title}</h3>
        )}
        {description && open ? <p className="inspector-section-description">{description}</p> : null}
      </div>
      {!collapsible || open ? children : null}
    </section>
  );
}
