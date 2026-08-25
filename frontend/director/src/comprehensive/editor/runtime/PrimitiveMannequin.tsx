/**
 * 程序化人体模型组件，将 bodyType、颜色和骨架状态委托给 ProceduralMannequin 渲染。
 *
 * @module primitive-mannequin
 */

import type { CharacterRigState } from "../schema/directorProject";
import { ProceduralMannequin } from "./mannequin/ProceduralMannequin";
import type { CharacterBodyType } from "./mannequin/bodyTypes";

interface PrimitiveMannequinProps {
  bodyType?: CharacterBodyType;
  color?: string;
  rigState?: CharacterRigState;
}

/**
 * 渲染一个程序化人体模型。
 * @param bodyType - 角色体型类型。
 * @param color - 模型颜色，默认 "#4F8EF7"。
 * @param rigState - 骨架状态，用于控制姿势。
 */
export function PrimitiveMannequin({ bodyType, color = "#4F8EF7", rigState }: PrimitiveMannequinProps) {
  return <ProceduralMannequin bodyType={bodyType} color={color} rigState={rigState} />;
}
