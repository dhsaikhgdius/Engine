# Runtime Data

> Languages: **English** · [中文](README.zh-CN.md)

This directory is the default local persistence root for Director sessions, jobs, previews, DCC exchanges, and mutable production state. **Only JSON Schemas and this README are tracked in Git**; all other runtime artifacts are excluded by `.gitignore`.

### Difference Between `.runtime/` and `data/`

- **`.runtime/`**: Generated scene snapshots, build trees, and local checkpoints—fully ignored by Git.
- **`data/`**: User-visible persistent runtime state (production data, sessions, job results, DCC exchanges); schemas are tracked in Git.

---

## File & Directory Inventory

### Top-level Files

| Path | Purpose |
|---|---|
| `director-agent-plan.schema.json` | Agent execution plan JSON Schema: defines constraints for `summary`, `operations` array (with `tool`, `input_json`, `summary` fields) |
| `director-agent-sessions.sqlite` | Agent session persistence SQLite database, storing conversation history, tool call records, and context |
| `director-agent-sessions.sqlite-shm` | SQLite shared-memory file (auto-generated during WAL-mode operation) |
| `director-agent-sessions.sqlite-wal` | SQLite write-ahead log file (auto-generated during WAL-mode operation) |
| `director-production.json` | Production project metadata: productionId, revision, scene list & editorial timeline |
| `director-production-state.json` | Full production state snapshot (all scene details, high revision count), large file |
| `director-workbench.json` | Director workbench global state (UI layout, panel config, user preferences) |
| `stage-scene.json` | Current Stage 3D scene complete data (models, cameras, lights, animation, etc.) |
| `stage-scene.json.*.tmp` | Temporary files during Stage scene writes (atomic-write intermediates; safe to clean after process exits) |
| `latest-preview.png` | Latest Stage scene render preview screenshot |

### Subdirectories

| Path | Purpose |
|---|---|
| `comfy-workflows/` | ComfyUI workflow JSON definition storage (currently empty) |
| `dcc-jobs/` | DCC job directory (see below) |
| `dcc-ledgers/` | DCC operation ledger directory (see below) |
| `film-runs/` | Film render run results storage (currently empty) |
| `blender/` | Blender native `.blend` file storage (`director-native.blend`, etc.), including dedup backups |

### `dcc-jobs/` Subdirectories

| Path | Purpose |
|---|---|
| `dcc-jobs/blender/` | Blender export jobs: each job dir contains `scene.blend`, `scene.director-dcc.json`, `report.json`, and optional `assets/` & `preview.png` |
| `dcc-jobs/blender-import/` | Blender import jobs: contains `source.blend`, `report.json`, `package/` (packaged output), and `plans/` (AI import plans) |
| `dcc-jobs/exchange/` | DCC exchange jobs (e.g., Blender bidirectional exchange) |

### `dcc-ledgers/` Subdirectories

| Path | Purpose |
|---|---|
| `dcc-ledgers/blender-scene-import/` | Blender scene import operation ledgers; content-hash-named JSON files record metadata & receipts for each import |

---

## Git Tracking Rules

```
data/**              # ignore all
!data/               # keep the directory itself
!data/*.schema.json  # only track JSON Schemas
!data/README.md      # track this file
!data/.gitkeep       # optional placeholder
```

Do not commit runtime snapshots, job artifacts, or `.blend` files to the repository. Place deterministic test inputs under the relevant `__fixtures__/` directory instead.