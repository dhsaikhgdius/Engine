/**
 * Cinematography preset picker and compatibility checker for the current camera.
 *
 * @module CinematographyAdvisor
 */

import { CircleAlert, CircleCheck, Info, Sparkles, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import {
  DIRECTOR_CINEMATOGRAPHY_PRESETS,
  createDirectorCinematographyCameraPatch,
  evaluateDirectorCinematography,
  getDirectorCinematographyPreset,
  type DirectorCinematographyCameraPatch,
  type DirectorCinematographyIssueSeverity,
  type DirectorCinematographyPresetId,
} from "../cinematography/directorCinematography";
import type { DirectorCameraShot } from "../schema/directorProject";
import { InspectorSection, InspectorSelectField } from "./InspectorControls";

const ISSUE_ICONS = {
  critical: CircleAlert,
  warning: TriangleAlert,
  info: Info,
} satisfies Record<DirectorCinematographyIssueSeverity, typeof Info>;

/**
 * Renders a cinematography advisor with a preset selector, parameter preview,
 * an apply button, and a severity-ranked compatibility checklist.
 */
export function CinematographyAdvisor({
  camera,
  onApply,
}: {
  camera: DirectorCameraShot;
  onApply: (patch: DirectorCinematographyCameraPatch) => void;
}) {
  const [selectedPresetId, setSelectedPresetId] = useState<DirectorCinematographyPresetId>("natural-narrative");
  const selectedPreset = getDirectorCinematographyPreset(selectedPresetId);
  const issues = useMemo(() => evaluateDirectorCinematography(camera), [camera]);
  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const statusClass = criticalCount > 0 ? "is-critical" : warningCount > 0 ? "is-warning" : "is-compatible";
  const statusLabel =
    criticalCount > 0 ? `${criticalCount} 项需要修正` : warningCount > 0 ? `${warningCount} 项兼容性建议` : "参数兼容";

  return (
    <InspectorSection collapsible defaultOpen={false} title="摄影指导">
      <div className="cinematography-advisor">
        <InspectorSelectField
          ariaLabel="摄影风格预设"
          label="风格预设"
          onChange={(value) => setSelectedPresetId(value as DirectorCinematographyPresetId)}
          value={selectedPresetId}
        >
          {DIRECTOR_CINEMATOGRAPHY_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </InspectorSelectField>
        <div className="cinematography-preset-preview" aria-label="摄影预设说明">
          <p>{selectedPreset.description}</p>
          <span>{selectedPreset.bestFor}</span>
          <output aria-label="摄影预设参数">
            {selectedPreset.settings.sensorFormat === "fullFrame"
              ? "Full Frame"
              : selectedPreset.settings.sensorFormat === "super35"
                ? "Super 35"
                : selectedPreset.settings.sensorFormat === "super16"
                  ? "Super 16"
                  : "65mm / IMAX"}
            {" · "}
            {selectedPreset.settings.focalLengthMm} mm · f/{selectedPreset.settings.apertureFStop} ·{" "}
            {selectedPreset.settings.aspectRatio}
          </output>
        </div>
        <button
          aria-label={`应用摄影预设 ${selectedPreset.name}`}
          className="camera-action-path-button cinematography-apply-button is-primary"
          onClick={() => onApply(createDirectorCinematographyCameraPatch(selectedPreset))}
          type="button"
        >
          <Sparkles aria-hidden size={14} strokeWidth={1.9} />
          应用到当前机位
        </button>
        <div aria-label="摄影兼容性检查" className={`cinematography-compatibility ${statusClass}`} role="status">
          <div className="cinematography-compatibility-heading">
            {criticalCount === 0 && warningCount === 0 ? (
              <CircleCheck aria-hidden size={14} />
            ) : criticalCount > 0 ? (
              <CircleAlert aria-hidden size={14} />
            ) : (
              <TriangleAlert aria-hidden size={14} />
            )}
            <strong>{statusLabel}</strong>
            {issues.length > criticalCount + warningCount ? (
              <span>{issues.length - criticalCount - warningCount} 条提示</span>
            ) : null}
          </div>
          {issues.length > 0 ? (
            <ul aria-label="摄影兼容性建议">
              {issues.map((issue) => {
                const IssueIcon = ISSUE_ICONS[issue.severity];
                return (
                  <li className={`is-${issue.severity}`} key={issue.code}>
                    <IssueIcon aria-hidden size={12} />
                    <span>
                      <strong>{issue.title}</strong>
                      <small>{issue.detail}</small>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>当前镜头、画幅、曝光和运动参数没有明显冲突。</p>
          )}
        </div>
      </div>
    </InspectorSection>
  );
}
