/**
 * 使用 FBXLoader 加载本地 Director 角色模型，并委托给 MixamoRiggedCharacter 渲染。
 *
 * @module director-character-model
 */

import { useLoader } from "@react-three/fiber";
import { memo } from "react";
import { DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M } from "./mixamo/mixamoCharacterRig";
import { MixamoRiggedCharacter, type MixamoCharacterSourceProps } from "./mixamo/MixamoRiggedCharacter";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

/** Props for the DirectorCharacterModel component, re-exported from MixamoRiggedCharacter. */
export type DirectorCharacterModelProps = MixamoCharacterSourceProps;

/** 加载并渲染 Director 角色模型，使用 FBXLoader 加载指定 URL 的 FBX 场景。 */
export const DirectorCharacterModel = memo(function DirectorCharacterModel({
  url,
  targetHeightM = DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M,
  ...props
}: DirectorCharacterModelProps) {
  const fbx = useLoader(FBXLoader, url);

  return (
    <MixamoRiggedCharacter
      {...props}
      rootName="director-character"
      source={fbx}
      sourceKey={url}
      targetHeightM={targetHeightM}
    />
  );
});
