/**
 * 使用 GLTFLoader 加载 Mixamo 角色模型，并委托给 MixamoRiggedCharacter 渲染。
 *
 * @module mixamo-character-model
 */

import { useLoader } from "@react-three/fiber";
import { memo } from "react";
import { DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M } from "./mixamo/mixamoCharacterRig";
import { MixamoRiggedCharacter, type MixamoCharacterSourceProps } from "./mixamo/MixamoRiggedCharacter";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { configureDirectorGLTFLoader } from "./gltfLoader";

/** Props for the MixamoCharacterModel component, re-exported from MixamoRiggedCharacter. */
export type MixamoCharacterModelProps = MixamoCharacterSourceProps;

/** 加载并渲染 Mixamo 角色模型，使用 GLTFLoader 加载指定 URL 的 glTF 场景。 */
export const MixamoCharacterModel = memo(function MixamoCharacterModel({
  url,
  targetHeightM = DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M,
  ...props
}: MixamoCharacterModelProps) {
  const gltf = useLoader(GLTFLoader, url, configureDirectorGLTFLoader);

  return (
    <MixamoRiggedCharacter
      {...props}
      rootName="director-mixamo-character"
      source={gltf.scene}
      sourceKey={url}
      targetHeightM={targetHeightM}
    />
  );
});
