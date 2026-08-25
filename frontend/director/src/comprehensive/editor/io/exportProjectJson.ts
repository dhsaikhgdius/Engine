import type { DirectorProject } from "../schema/directorProject";
import { persistProductionGraphIdentities } from "../productionGraph/productionGraphMigration";

/**
 * Serializes a Director project to a pretty-printed JSON string for export.
 *
 * Graph identities are backfilled additively so archive round-trips preserve
 * stable ProductionGraph IDs without changing the project revision hash.
 *
 * @param project - The project to serialize.
 * @returns A 2-space-indented JSON string.
 */
export function serializeProject(project: DirectorProject) {
  return JSON.stringify(persistProductionGraphIdentities(project), null, 2);
}
