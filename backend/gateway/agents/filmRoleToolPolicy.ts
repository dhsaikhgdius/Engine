/**
 * Gateway entry point for the shared Director film-role tool policy.
 *
 * The allow-table itself lives in `packages/protocol/src/filmRoleToolPolicy.ts`
 * so the browser UI can gate write controls with the exact same logic without
 * importing gateway code (see `tools/scripts/checkServerImportBoundaries.ts`).
 * Gateway modules keep importing from this path.
 */
export * from "../../../packages/protocol/src/filmRoleToolPolicy";
