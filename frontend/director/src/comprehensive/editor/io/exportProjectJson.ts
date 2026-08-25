import type { DirectorProject } from "../schema/directorProject";

/**
 * Serializes a Director project to a pretty-printed JSON string for export.
 *
 * @param project - The project to serialize.
 * @returns A 2-space-indented JSON string.
 */
export function serializeProject(project: DirectorProject) {
  return JSON.stringify(project, null, 2);
}
