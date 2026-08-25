# Local Flick Stage catalog mirror

This directory is populated by `npm run sync:flick-catalog` from the public URLs recorded in `catalog.json`.

- GLB files are kept locally so the Director model library does not make runtime requests to Flick.
- `catalog.json` preserves every source URL; `sync-report.json` records the synchronization result; and `texture-audit.json` records every discovered texture reference plus its local/provenance status.
- When a GLB references a texture that Flick's CDN no longer serves, the sync intentionally leaves it unresolved and records the failure. It never substitutes a different texture while claiming an exact mirror.
- This folder is a local mirror of third-party assets, not an assertion of ownership or a relicensing of those assets.

To regenerate or resume a partial mirror, run `npm run sync:flick-catalog` from the repository root.
