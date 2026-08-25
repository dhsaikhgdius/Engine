import { logDirectorProjectRepairs, parseDirectorProjectForLoad } from "../store/directorStore";

/**
 * Parses a JSON string into a validated Director project, applying repairs
 * and failing with a descriptive error when the data is structurally invalid.
 *
 * @param json - The JSON string to parse.
 * @returns A validated DirectorProject.
 */
export function parseProject(json: string) {
  const result = parseDirectorProjectForLoad(JSON.parse(json) as unknown);
  if (!result.success) throw new Error(result.error);
  logDirectorProjectRepairs("导入项目", result.repairs);
  return result.project;
}
