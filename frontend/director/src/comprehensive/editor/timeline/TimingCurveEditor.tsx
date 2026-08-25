/**
 * @module TimingCurveEditor
 * @description Cubic-bezier timing curve editor with an interactive SVG graph,
 *   preset buttons, numeric field inputs, and keyboard/pointer drag controls.
 */

import { useRef } from "react";
import { clamp } from "../../../../../../packages/protocol/src/primitives";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { DirectorAnimationTimingCurve } from "../schema/directorProject";
import { DIRECTOR_TIMING_CURVE_PRESETS } from "../schema/animationEasing";

const VIEW_WIDTH = 220;
const VIEW_HEIGHT = 150;
const PLOT_LEFT = 18;
const PLOT_RIGHT = 202;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 134;
const GRAPH_Y_MIN = -0.25;
const GRAPH_Y_MAX = 1.25;

const PRESETS = [
  { id: "linear", label: "线性", curve: DIRECTOR_TIMING_CURVE_PRESETS.linear },
  { id: "easeIn", label: "渐入", curve: DIRECTOR_TIMING_CURVE_PRESETS.easeIn },
  { id: "easeOut", label: "渐出", curve: DIRECTOR_TIMING_CURVE_PRESETS.easeOut },
  { id: "easeInOut", label: "渐入渐出", curve: DIRECTOR_TIMING_CURVE_PRESETS.easeInOut },
] as const;

interface TimingCurveEditorProps {
  disabled?: boolean;
  fallbackValue?: DirectorAnimationTimingCurve;
  value?: DirectorAnimationTimingCurve;
  onChange: (value: DirectorAnimationTimingCurve) => void;
  onReset?: () => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

function roundCurveValue(value: number) {
  return Math.round(value * 1000) / 1000;
}

function graphX(value: number) {
  return PLOT_LEFT + clamp(value, 0, 1) * (PLOT_RIGHT - PLOT_LEFT);
}

function graphY(value: number) {
  const normalized = (clamp(value, GRAPH_Y_MIN, GRAPH_Y_MAX) - GRAPH_Y_MIN) / (GRAPH_Y_MAX - GRAPH_Y_MIN);
  return PLOT_BOTTOM - normalized * (PLOT_BOTTOM - PLOT_TOP);
}

function curvesEqual(left: DirectorAnimationTimingCurve | undefined, right: DirectorAnimationTimingCurve) {
  return (
    Boolean(left) &&
    Math.abs(left!.x1 - right.x1) < 0.0001 &&
    Math.abs(left!.y1 - right.y1) < 0.0001 &&
    Math.abs(left!.x2 - right.x2) < 0.0001 &&
    Math.abs(left!.y2 - right.y2) < 0.0001
  );
}

export function TimingCurveEditor({
  disabled = false,
  fallbackValue = DIRECTOR_TIMING_CURVE_PRESETS.linear,
  value,
  onChange,
  onReset,
  onInteractionStart,
  onInteractionEnd,
}: TimingCurveEditorProps) {
  const curve = value ?? fallbackValue;
  const interactionActive = useRef(false);

  function startInteraction() {
    if (interactionActive.current) return;
    interactionActive.current = true;
    onInteractionStart?.();
  }

  function endInteraction() {
    if (!interactionActive.current) return;
    interactionActive.current = false;
    onInteractionEnd?.();
  }

  function updateHandle(handle: "first" | "second", x: number, y: number) {
    const next = {
      ...curve,
      ...(handle === "first"
        ? { x1: roundCurveValue(clamp(x, 0, 1)), y1: roundCurveValue(clamp(y, GRAPH_Y_MIN, GRAPH_Y_MAX)) }
        : { x2: roundCurveValue(clamp(x, 0, 1)), y2: roundCurveValue(clamp(y, GRAPH_Y_MIN, GRAPH_Y_MAX)) }),
    };
    onChange(next);
  }

  function updateHandleFromPointer(handle: "first" | "second", event: ReactPointerEvent<SVGCircleElement>) {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const bounds = svg.getBoundingClientRect();
    const pointX = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * VIEW_WIDTH;
    const pointY = ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * VIEW_HEIGHT;
    const x = (pointX - PLOT_LEFT) / (PLOT_RIGHT - PLOT_LEFT);
    const y = GRAPH_Y_MIN + ((PLOT_BOTTOM - pointY) / (PLOT_BOTTOM - PLOT_TOP)) * (GRAPH_Y_MAX - GRAPH_Y_MIN);
    updateHandle(handle, x, y);
  }

  function handlePointerDown(event: ReactPointerEvent<SVGCircleElement>) {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startInteraction();
  }

  function handlePointerEnd(event: ReactPointerEvent<SVGCircleElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    endInteraction();
  }

  function handleKeyDown(handle: "first" | "second", event: KeyboardEvent<SVGCircleElement>) {
    if (disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.1 : 0.02;
    const currentX = handle === "first" ? curve.x1 : curve.x2;
    const currentY = handle === "first" ? curve.y1 : curve.y2;
    updateHandle(
      handle,
      currentX + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
      currentY + (event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0),
    );
  }

  function updateField(field: keyof DirectorAnimationTimingCurve, rawValue: string) {
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;
    const isX = field === "x1" || field === "x2";
    onChange({
      ...curve,
      [field]: roundCurveValue(clamp(numeric, isX ? 0 : GRAPH_Y_MIN, isX ? 1 : GRAPH_Y_MAX)),
    });
  }

  const start = { x: graphX(0), y: graphY(0) };
  const end = { x: graphX(1), y: graphY(1) };
  const first = { x: graphX(curve.x1), y: graphY(curve.y1) };
  const second = { x: graphX(curve.x2), y: graphY(curve.y2) };

  return (
    <div className={`timing-curve-editor${disabled ? " is-disabled" : ""}`}>
      <p className="timing-curve-caption">横轴是时间，纵轴是走完的程度。</p>
      <div className="timing-curve-presets" aria-label="时间缓动预设">
        {PRESETS.map((preset) => (
          <button
            aria-pressed={curvesEqual(value, preset.curve)}
            className={curvesEqual(value, preset.curve) ? "is-active" : ""}
            disabled={disabled}
            key={preset.id}
            type="button"
            onClick={() => onChange({ ...preset.curve })}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <svg
        aria-label="时间缓动贝塞尔曲线"
        className="timing-curve-graph"
        role="img"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      >
        <rect
          className="timing-curve-plot"
          x={PLOT_LEFT}
          y={PLOT_TOP}
          width={PLOT_RIGHT - PLOT_LEFT}
          height={PLOT_BOTTOM - PLOT_TOP}
        />
        <line className="timing-curve-grid" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={graphY(0)} y2={graphY(0)} />
        <line className="timing-curve-grid" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={graphY(1)} y2={graphY(1)} />
        <line className="timing-curve-handle-line" x1={start.x} y1={start.y} x2={first.x} y2={first.y} />
        <line className="timing-curve-handle-line" x1={end.x} y1={end.y} x2={second.x} y2={second.y} />
        <path
          className="timing-curve-path"
          d={`M ${start.x} ${start.y} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${end.x} ${end.y}`}
        />
        <circle className="timing-curve-endpoint" cx={start.x} cy={start.y} r="3" />
        <circle className="timing-curve-endpoint" cx={end.x} cy={end.y} r="3" />
        <circle
          aria-label="第一个时间缓动控制点"
          className="timing-curve-control"
          cx={first.x}
          cy={first.y}
          r="7"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          onKeyDown={(event) => handleKeyDown("first", event)}
          onPointerCancel={handlePointerEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateHandleFromPointer("first", event);
          }}
          onPointerUp={handlePointerEnd}
        />
        <circle
          aria-label="第二个时间缓动控制点"
          className="timing-curve-control"
          cx={second.x}
          cy={second.y}
          r="7"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          onKeyDown={(event) => handleKeyDown("second", event)}
          onPointerCancel={handlePointerEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateHandleFromPointer("second", event);
          }}
          onPointerUp={handlePointerEnd}
        />
      </svg>
      <div className="timing-curve-fields">
        {(["x1", "y1", "x2", "y2"] as const).map((field) => (
          <label key={field}>
            <span>{field.toUpperCase()}</span>
            <input
              aria-label={`时间缓动 ${field.toUpperCase()}`}
              disabled={disabled}
              max={field.startsWith("x") ? 1 : GRAPH_Y_MAX}
              min={field.startsWith("x") ? 0 : GRAPH_Y_MIN}
              step="0.01"
              type="number"
              value={curve[field]}
              onBlur={endInteraction}
              onChange={(event) => updateField(field, event.currentTarget.value)}
              onFocus={startInteraction}
            />
          </label>
        ))}
      </div>
      <div className="timing-curve-footer">
        <span>
          {disabled
            ? "保持插值不使用缓动曲线"
            : value
              ? "这条曲线只改快慢：从这一帧走到下一帧。"
              : "还没改过快慢。拖图或改数值后会变成自定义缓动。"}
        </span>
        {value && onReset ? (
          <button disabled={disabled} type="button" onClick={onReset}>
            重置
          </button>
        ) : null}
      </div>
    </div>
  );
}
