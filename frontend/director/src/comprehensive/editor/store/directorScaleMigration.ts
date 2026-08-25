import { getCatalogDefaultSizeM } from "@director/dcc-interchange";
import { getFlickStandardCategory } from "../modelLibrary/modelLibraryCatalog";
import { DIRECTOR_AGENT_ASSET_CATALOG, getDirectorAgentCatalogAsset } from "@director/agent-engine/asset-catalog";
import type { DirectorAssetRef, DirectorProject } from "../schema/directorProject";
import { DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE } from "../runtime/importedModelGeometry";

/** Packaged props are served as /flick-stage-props/<source category>/<file>.glb. */
const PACKAGED_PROP_URL_PREFIX = "/flick-stage-props/";

/**
 * Metric sizes of packaged models keyed by model URL, so a legacy asset whose
 * id was renamed (or was never a catalog id) still resolves to catalog scale.
 * The first sized item wins; DIRECTOR_AGENT_ASSET_CATALOG is deterministically
 * sorted, so the map is stable across loads.
 */
const catalogSizeByModelUrl = new Map<string, number>();
DIRECTOR_AGENT_ASSET_CATALOG.forEach((item) => {
  const sizeM = item.asset.realWorldSizeM;
  if (sizeM === undefined || catalogSizeByModelUrl.has(item.model_url)) return;
  catalogSizeByModelUrl.set(item.model_url, sizeM);
});

function getPackagedSourceCategory(url: string) {
  if (!url.startsWith(PACKAGED_PROP_URL_PREFIX)) return null;
  const [category, fileName, ...extraSegments] = url.slice(PACKAGED_PROP_URL_PREFIX.length).split("/");
  if (!category || !fileName || extraSegments.length || !/\.glb$/i.test(fileName)) return null;
  return category;
}

function isCatalogScaleEligibleModelAsset(asset: DirectorAssetRef) {
  return (
    asset.sourceType === "model" &&
    // Characters normalize by rig height and panoramas are not scaled at all.
    asset.kind !== "character" &&
    asset.kind !== "panorama" &&
    // "preserve" assets already carry a server-normalized metric scale.
    asset.modelNormalization !== "preserve" &&
    // Catalog-owned values may follow catalog corrections. User and estimated
    // sizes are explicit project decisions and must remain untouched.
    (asset.realWorldSizeM === undefined || asset.sizeSource === "catalog")
  );
}

function needsEstimatedModelFallback(asset: DirectorAssetRef) {
  return (
    asset.sourceType === "model" &&
    asset.kind !== "character" &&
    asset.kind !== "panorama" &&
    asset.modelNormalization !== "preserve" &&
    asset.realWorldSizeM === undefined
  );
}

/**
 * Resolves the current metric size for a packaged catalog asset, or undefined
 * when the asset must keep its project-authored normalization. User and local
 * models have no catalog-owned physical size and are never guessed here.
 */
function resolveCatalogAssetRealWorldSizeM(asset: DirectorAssetRef): number | undefined {
  if (!isCatalogScaleEligibleModelAsset(asset)) return undefined;

  const catalogIdentitySizeM = getDirectorAgentCatalogAsset(asset.id)?.asset.realWorldSizeM;
  if (catalogIdentitySizeM !== undefined) return catalogIdentitySizeM;

  const catalogUrlSizeM = catalogSizeByModelUrl.get(asset.url);
  if (catalogUrlSizeM !== undefined) return catalogUrlSizeM;

  const sourceCategory = getPackagedSourceCategory(asset.url);
  if (!sourceCategory) return undefined;

  return getCatalogDefaultSizeM({
    kind: asset.kind === "scene" ? "scene" : "prop",
    sourceCategory,
    standardCategory: getFlickStandardCategory(sourceCategory),
    fileName: asset.fileName,
  });
}

/**
 * Backfills missing catalog metric sizes and refreshes catalog-owned values
 * when the catalog's physical dimensions improve. Generic auto-normalized
 * models record the same 2 m fallback the renderer already used implicitly.
 * User and existing estimated sizes and server-normalized assets remain
 * untouched.
 */
export function backfillDirectorAssetMetricScale(project: DirectorProject): DirectorProject {
  let updated = false;
  const assets = project.assets.map((asset) => {
    const realWorldSizeM = resolveCatalogAssetRealWorldSizeM(asset);
    if (realWorldSizeM !== undefined) {
      if (asset.realWorldSizeM === realWorldSizeM && asset.sizeSource === "catalog") return asset;
      updated = true;
      return { ...asset, realWorldSizeM, sizeSource: "catalog" as const };
    }
    if (!needsEstimatedModelFallback(asset)) return asset;
    updated = true;
    return {
      ...asset,
      realWorldSizeM: DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE,
      sizeSource: "estimated" as const,
    };
  });

  return updated ? { ...project, assets } : project;
}
