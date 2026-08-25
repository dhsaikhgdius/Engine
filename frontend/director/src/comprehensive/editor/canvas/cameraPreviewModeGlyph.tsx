/**
 * 摄像机预览模式图标，根据预览模式（previz、rgb、depth、normal、objectid、mask、motion）渲染不同的立方体图示。
 *
 * @module camera-preview-mode-glyph
 */

import { useId } from "react";
import type { DirectorCameraPreviewMode } from "../render/cameraPreviewModality";

const CUBE = {
  top: "M12 3.2 21.4 8.6 12 14 2.6 8.6Z",
  left: "M2.6 8.6 12 14v8.6L2.6 17.2Z",
  right: "M21.4 8.6 12 14v8.6l9.4-5.4Z",
  highlight: "M12 3.2 16.6 5.85 12 8.5 7.4 5.85Z",
  wire: "M12 3.2 21.4 8.6 12 14 2.6 8.6Z M2.6 8.6v8.6L12 22.6l9.4-5.4V8.6 M12 14v8.6",
} as const;

const FACE_STROKE = "rgba(8,12,20,0.38)";

function CubeShadow() {
  return <ellipse cx="12" cy="22.85" fill="rgba(0,0,0,0.34)" rx="7.1" ry="1.2" />;
}

function CubeFaces({ highlight, left, right, top }: { highlight?: string; left: string; right: string; top: string }) {
  return (
    <>
      <CubeShadow />
      <path d={CUBE.left} fill={left} stroke={FACE_STROKE} strokeWidth="0.55" />
      <path d={CUBE.right} fill={right} stroke={FACE_STROKE} strokeWidth="0.55" />
      <path d={CUBE.top} fill={top} stroke={FACE_STROKE} strokeWidth="0.55" />
      {highlight ? <path d={CUBE.highlight} fill={highlight} /> : null}
    </>
  );
}

function CameraPreviewModeGlyphArt({ mode, uid }: { mode: DirectorCameraPreviewMode; uid: string }) {
  if (mode === "previz") {
    return <CubeFaces highlight="rgba(255,255,255,0.28)" left="#c4ae97" right="#a89076" top="#e6d5c4" />;
  }

  if (mode === "rgb") {
    return <CubeFaces highlight="rgba(255,255,255,0.34)" left="#2f9e66" right="#3b7ded" top="#e24b4f" />;
  }

  if (mode === "depth") {
    const gradientId = `${uid}-depth`;
    return (
      <>
        <defs>
          <linearGradient gradientUnits="userSpaceOnUse" id={gradientId} x1="12" x2="12" y1="3.2" y2="22.6">
            <stop offset="0" stopColor="#f5f7fa" />
            <stop offset="0.48" stopColor="#8b919c" />
            <stop offset="1" stopColor="#12151c" />
          </linearGradient>
        </defs>
        <CubeShadow />
        <path d={`${CUBE.left} ${CUBE.right} ${CUBE.top}`} fill={`url(#${gradientId})`} />
        <path d={`${CUBE.left} ${CUBE.right} ${CUBE.top}`} fill="none" stroke={FACE_STROKE} strokeWidth="0.55" />
      </>
    );
  }

  if (mode === "normal") {
    return <CubeFaces left="#6f74f0" right="#f0719a" top="#6ee7a0" />;
  }

  if (mode === "objectid") {
    return <CubeFaces left="#3ecfc4" right="#ffd166" top="#ff5d73" />;
  }

  if (mode === "mask") {
    return (
      <>
        <rect fill="#0c1018" height="20.5" rx="5" width="20.5" x="1.75" y="1.75" />
        <CubeFaces left="#dfe3ea" right="#c5cad3" top="#f7f8fb" />
      </>
    );
  }

  if (mode === "motion") {
    const gradientId = `${uid}-motion`;
    return (
      <>
        <defs>
          <linearGradient gradientUnits="userSpaceOnUse" id={gradientId} x1="2.6" x2="21.4" y1="22.6" y2="3.2">
            <stop offset="0" stopColor="#22d3ee" />
            <stop offset="0.35" stopColor="#a3e635" />
            <stop offset="0.65" stopColor="#f59e0b" />
            <stop offset="1" stopColor="#f43f5e" />
          </linearGradient>
        </defs>
        <CubeFaces left="#22d3ee" right="#f43f5e" top="#f59e0b" highlight="rgba(255,255,255,0.28)" />
        <path d={CUBE.wire} fill="none" stroke={`url(#${gradientId})`} strokeWidth="0.7" />
      </>
    );
  }

  return (
    <>
      <CubeShadow />
      <path d={`${CUBE.left} ${CUBE.right} ${CUBE.top}`} fill="rgba(18,22,30,0.72)" />
      <path
        d={CUBE.wire}
        fill="none"
        stroke="#e7edf6"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </>
  );
}

/**
 * 渲染一个 24x24 SVG 图标，根据摄像机预览模式显示不同颜色的立方体图示。
 * @param mode - 摄像机预览模式。
 */
export function CameraPreviewModeGlyph({ mode }: { mode: DirectorCameraPreviewMode }) {
  const uid = useId().replace(/:/g, "");

  return (
    <svg
      aria-hidden="true"
      className="camera-picture-in-picture__mode-glyph"
      data-preview-mode={mode}
      fill="none"
      viewBox="0 0 24 24"
    >
      <CameraPreviewModeGlyphArt mode={mode} uid={uid} />
    </svg>
  );
}
