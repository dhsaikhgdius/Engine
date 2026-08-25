import { registerDirectorWorkbenchPlugin } from "./register";

export const name = "director-workbench";
export const inject = ["tools", "llm", "systemPrompt"];

export function apply(context: Parameters<typeof registerDirectorWorkbenchPlugin>[0]) {
  registerDirectorWorkbenchPlugin(context);
}
