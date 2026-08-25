/**
 * 角色模型入口组件，根据体型自动选择 Mixamo 角色模型，降级渲染为程序化人偶。
 *
 * @module character-model
 */

import { Component, Suspense, memo, type ReactNode } from "react";
import type { CharacterRigState } from "../schema/directorProject";
import { MixamoCharacterModel } from "./MixamoCharacterModel";
import { PrimitiveMannequin } from "./PrimitiveMannequin";
import type { CharacterBodyType } from "./mannequin/bodyTypes";

/** 默认英雄角色模型的 glTF 资源 URL。 */
export const DEFAULT_HERO_CHARACTER_URL = "/mixamo-characters/models/x-bot.glb";

/** 获取默认的 Director 角色 URL，当前始终返回默认英雄角色。 */
export function getDefaultDirectorCharacterUrl(_bodyType: CharacterBodyType = "mannequin") {
  return DEFAULT_HERO_CHARACTER_URL;
}

interface CharacterModelProps {
  bodyType?: CharacterBodyType;
  color?: string;
  onLabelAnchorYChange?: (anchorY: number) => void;
  rigState?: CharacterRigState;
  currentFrame?: number;
  fps?: number;
  runtimeControlled?: boolean;
}

class CharacterModelBoundary extends Component<
  {
    fallback: ReactNode;
    children: ReactNode;
  },
  {
    hasError: boolean;
  }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/**
 * 渲染一个角色模型，优先使用 Mixamo 角色，加载失败或挂起时降级为程序化人偶。
 * @param bodyType - 角色体型类型。
 * @param color - 程序化人偶降级时的颜色。
 * @param onLabelAnchorYChange - 标签锚点 Y 坐标变更回调。
 * @param rigState - 骨架状态，用于控制姿势和动画。
 * @param currentFrame - 当前帧。
 * @param fps - 帧率。
 * @param runtimeControlled - 是否由运行时控制运动混合。
 */
export const CharacterModel = memo(function CharacterModel({
  bodyType,
  color,
  onLabelAnchorYChange,
  rigState,
  currentFrame,
  fps,
  runtimeControlled,
}: CharacterModelProps) {
  const fallback = <PrimitiveMannequin bodyType={bodyType} color={color} rigState={rigState} />;

  return (
    <CharacterModelBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <MixamoCharacterModel
          bodyType={bodyType}
          currentFrame={currentFrame}
          fps={fps}
          onLabelAnchorYChange={onLabelAnchorYChange}
          rigState={rigState}
          runtimeControlled={runtimeControlled}
          url={getDefaultDirectorCharacterUrl(bodyType)}
        />
      </Suspense>
    </CharacterModelBoundary>
  );
});
