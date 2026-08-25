---
title: Open-source Assets & Hugging Face
description: Keep Director source on GitHub while restoring licensed runtime assets from immutable Hugging Face revisions.
---

Director uses a **source repository** and an **asset supply chain**. They are deliberately separate:

- GitHub contains code, schemas, catalogs, tests, documentation, generators, checksums, licenses, and notices.
- Hugging Face contains only binary assets for which redistribution has been explicitly cleared.
- User-provided or unresolved third-party content stays on the user's machine. It is never made downloadable merely by putting it in a private or gated repository.

This is a licensing boundary, a repository-size boundary, and a reproducibility boundary. Git LFS in the
source repository is not a substitute for it.

## Distribution classes

| Class                      | Examples in this checkout                                                                            | Distribution rule                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Public, redistributable    | procedurally generated open mannequin; original low-poly props covered by their adjacent MIT notices | May be uploaded to a public HF dataset after the notice, checksum, and provenance are reviewed                                             |
| User-provided / local-only | Mixamo characters and animations exported by an individual account                                   | Keep local; the manifest records expected hashes and provisioning instructions, but no repository or remote path                           |
| Unresolved provenance      | the local Flick Stage mirror and its thumbnails                                                      | Keep local until each upstream asset has explicit redistribution permission; do not publish it to public, gated, or private shared bundles |
| Review evidence            | third-party screenshots captured during clean-room comparison                                        | Link the public page; do not ship the screenshot unless its redistribution rights are recorded                                             |

Adobe's [Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) permits broad use in
projects, but that must not be represented as permission to publish a standalone character or animation
library. Director therefore treats the current Mixamo package as `user-provided`.

## Repository boundary

The root `.gitignore` defaults model, DCC, weight, media, downloaded, generated, and mutable runtime
payloads out of Git. It intentionally keeps these small source artifacts:

- `assets/library/**/catalog.json`: Agent/UI discovery metadata;
- `README`, `LICENSE`, `NOTICE`, and `SHA256SUMS` files;
- `assets/manifest.schema.json` and manifest lock metadata;
- textual interchange fixtures under `frontend/director/src/**/__fixtures__/`;
- Director-authored documentation images within the documented size budget;
- legally vendored source under `vendor/`, provided it includes its own license and pinned provenance.

New libraries additionally carry the Asset Catalog v2 manifest
(`assets/library/<library>/catalog.v2.json`; zod contract in
`packages/protocol/src/assetCatalogProtocol.ts`). Generate or update it with the developer ingest
CLI, `npx tsx tools/scripts/asset-ingest.ts <files...> --library <library>`; see
[Assets and characters for Agents](/agents/assets/).

Local research clones belong in `.external/`. Official inference runtimes remain Git
submodules (`vendor/ltx-2`,
`vendor/hunyuan3d`, `vendor/trellis`,
`vendor/ardy`); they are not copied into another source tree.

Run the read-only boundary audit before staging a release:

```bash
npm run repo:check
```

The audit inspects both tracked and unignored files. It rejects credentials, model/checkpoint/media payloads,
database state, oversized source files, and a regression that makes required catalogs or schemas ignored.

## Hugging Face layout

Create a dedicated **dataset** repository for cleared assets. Mirror runtime paths inside it so every manifest
entry has an obvious destination:

```text
director-open-assets/
  README.md
  LICENSES/
    director-open-mannequin.MIT.txt
    director-builtins.MIT.txt
  assets/
    runtime/
      models/
        storyai-open-mannequin.glb
      model-library/
        models/...
        thumbnails/...
  provenance/
    SHA256SUMS
    build-receipts.json
```

Do not stage the whole Director `assets/library/` folder. Build a clean upload directory containing only cleared
files. In particular, exclude `mixamo-*`, `flick-stage-props`, downloader output, DCC jobs, previews, and
external reference screenshots.

The current official Hugging Face CLI uses `hf upload` for folder uploads and resumes interrupted uploads.
See the [official upload guide](https://huggingface.co/docs/huggingface_hub/en/guides/upload).

```bash
python -m pip install --upgrade huggingface_hub
hf auth login
hf repo create YOUR_HF_ORG/director-open-assets --repo-type dataset
hf upload YOUR_HF_ORG/director-open-assets /absolute/path/to/cleared-staging . \
  --repo-type dataset \
  --commit-message "Director open assets 0.1.0"
```

After upload, resolve and record the **full commit SHA**, never `main`, a moving tag, or an abbreviated SHA:

```bash
git ls-remote https://huggingface.co/datasets/YOUR_HF_ORG/director-open-assets.git refs/heads/main
```

Hugging Face also documents full commit hashes as the reproducible revision form in its
[download guide](https://huggingface.co/docs/huggingface_hub/en/guides/download#from-specific-version).

## Manifest v1

The contract is `assets/manifest.schema.json`; `assets/manifest.example.json` shows both source kinds.
Create `assets/manifest.lock.json` only after the dataset exists, then commit that lock with the code.

Each downloadable file records:

- stable `id` and logical `bundle`;
- a `huggingface` source with repository ID and remote path;
- the exact local runtime path;
- byte length and lowercase SHA-256;
- MIME type, license reference, and required/optional status.

Each local-only file instead uses a `user-provided` source with explicit acquisition/packaging instructions.
It has no HF repository ID and no remote path. The installer will verify an existing local file but will not
attempt to acquire or redistribute it.

Repository revisions must be immutable 40-character commit SHAs. The all-zero revision and
`YOUR_HF_ORG` in the example are deliberately rejected by `release-check`.

## Restore and verify

The installer uses repository-relative allowlisted destinations, rejects traversal and symlink escapes,
downloads to a temporary file, verifies byte length and SHA-256, and then renames atomically.

```bash
# Inspect local availability without changing files.
npm run assets:status

# Download only manifest entries with a redistributable Hugging Face source.
# Required user-provided files produce actionable instructions when absent.
npm run assets:install

# Verify required local files without network access.
npm run assets:verify

# Reject placeholders and verify every required file before a release.
npm run assets:release-check
```

Use `-- --manifest path/to/manifest.json`, `-- --bundle open-models`, or
`-- --required-only` after an npm command. `--force` replaces a mismatched downloadable file only after the
replacement passes integrity verification. It never makes a user-provided file downloadable.

## CI and test tiers

A fresh public clone must build and run core tests without GLB, FBX, thumbnails, or local databases. Tests
that parse real packaged assets belong in the explicit local asset tier:

```bash
npm test             # alias of the assetless core suite
npm run test:core    # source/contract/UI suite; no binary assets required
npm run test:assets  # requires locally provisioned asset catalogs and payloads
npm run test:all     # core plus local asset acceptance, for release workstations
```

The asset runner owns its internal opt-in environment flag; call these npm scripts instead of setting that
flag directly.

Do not make public CI depend on an account-specific Mixamo export or the unresolved Flick mirror. A release
job may run `assets:install` only against a committed, non-placeholder manifest of cleared files.

## Release checklist

1. Audit each candidate's author, source, license, modification rights, and redistribution rights.
2. Put only cleared files into a new staging directory; generate hashes and provenance receipts.
3. Upload that directory to the public HF dataset.
4. Pin the resulting full commit SHA in `assets/manifest.lock.json`.
5. Restore into a clean clone and run `assets:release-check`.
6. Run `repo:check`, `test:all` on the licensed release workstation, lint, build, and docs build.
7. Review `git status --ignored`; stage metadata and source, never ignored payloads.
8. Push GitHub only after the source tree and HF revision reproduce the same verified runtime layout.

If a binary was previously committed, adding `.gitignore` is not enough: remove it from the index before the
next commit. If it exists in published history, coordinate a history rewrite and credential/cache invalidation
instead of silently force-pushing over collaborators.
