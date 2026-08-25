import {
  createMixamoCharacterAssetRef,
  getMixamoCharacterCatalogItem,
} from "../modelLibrary/mixamoCharacterCatalog";
import type { DirectorAssetRef, DirectorProject } from "../schema/directorProject";
import { parseDirectorProject } from "../schema/directorProjectSchema";
import dialogueTwoCharactersJson from "./dialogueTwoCharacters.json";
import emptyStageJson from "./emptyStage.json";
import followShotJson from "./followShot.json";
import orbitShowcaseJson from "./orbitShowcase.json";
import threePointPortraitJson from "./threePointPortrait.json";

export interface DirectorSceneTemplate {
  id: string;
  /** 卡片标题。 */
  name: string;
  /** 场景内容说明。 */
  description: string;
  /** 适用场景。 */
  useCase: string;
  /**
   * 模板工程文档。角色资产只以 assetRefId 引用打包目录里的角色，
   * 完整的资产引用（含骨骼元数据）在 buildDirectorSceneTemplateProject
   * 中从目录注入，保证模板永远引用真实存在的资产。
   */
  document: Record<string, unknown>;
}

export const DIRECTOR_SCENE_TEMPLATES: readonly DirectorSceneTemplate[] = Object.freeze([
  {
    id: "empty-stage",
    name: "空场景",
    description: "只保留默认灯光与一个 35mm 机位的干净片场，没有任何角色与道具。",
    useCase: "适用：从零开始自由搭建布景。",
    document: emptyStageJson,
  },
  {
    id: "dialogue-two-characters",
    name: "双人对话",
    description: "两个角色面对面站位，配全景主机位与一组 50mm 越肩正反打机位。",
    useCase: "适用：对话戏、访谈与剧情分镜。",
    document: dialogueTwoCharactersJson,
  },
  {
    id: "three-point-portrait",
    name: "三点布光人像",
    description: "主光、辅光、轮廓光的经典人像布光，搭配 85mm 特写机位。",
    useCase: "适用：人物打光、造型与质感预览。",
    document: threePointPortraitJson,
  },
  {
    id: "orbit-showcase",
    name: "环绕展示",
    description: "单主体居中，环绕轨迹机位在 10 秒内绕主体匀速一周。",
    useCase: "适用：资产展示与角色亮相镜头。",
    document: orbitShowcaseJson,
  },
  {
    id: "follow-shot",
    name: "追随镜头",
    description: "角色沿直线路径行走，跟随机位锁定角色保持背后视角。",
    useCase: "适用：行走跟拍与运动镜头预演。",
    document: followShotJson,
  },
]);

export function getDirectorSceneTemplate(templateId: string): DirectorSceneTemplate | null {
  return DIRECTOR_SCENE_TEMPLATES.find((template) => template.id === templateId) ?? null;
}

function collectTemplateCharacterAssetIds(document: Record<string, unknown>): string[] {
  const objects = Array.isArray(document.objects) ? (document.objects as Array<Record<string, unknown>>) : [];
  const assetIds = objects
    .filter((object) => object.kind === "character" && typeof object.assetRefId === "string")
    .map((object) => object.assetRefId as string);
  return [...new Set(assetIds)];
}

/**
 * 组装并严格校验一个模板工程：角色资产引用从打包 Mixamo 目录注入
 * （目录不存在的引用直接抛错），随后走完整的 directorProjectSchema
 * 校验，返回可直接交给 replaceProject 的工程文档。
 */
export function buildDirectorSceneTemplateProject(template: DirectorSceneTemplate): DirectorProject {
  const assets: DirectorAssetRef[] = collectTemplateCharacterAssetIds(template.document).map((assetId) => {
    const catalogItem = getMixamoCharacterCatalogItem(assetId);
    if (!catalogItem) {
      throw new Error(`场景模板「${template.name}」引用的角色资产 ${assetId} 不在打包角色目录中`);
    }
    return createMixamoCharacterAssetRef(catalogItem);
  });

  return parseDirectorProject({ ...template.document, assets });
}
