import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import type { DirectorAssetRef, DirectorObject, DirectorProject } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  canonicalizeDirectorProjectForRevision,
  DIRECTOR_PROJECT_REVISION_CONTRACT,
  getDirectorProjectRevision,
  sha256HexSync,
} from "../../../../src/comprehensive/editor/schema/directorProjectRevision";

function cloneProject(project: DirectorProject): DirectorProject {
  return structuredClone(project);
}

function addTwoAssets(project: DirectorProject): void {
  project.assets = [
    {
      id: "asset-a",
      kind: "prop",
      sourceType: "model",
      fileName: "a.glb",
      url: "https://assets.example/a.glb",
    },
    {
      id: "asset-b",
      kind: "prop",
      sourceType: "model",
      fileName: "b.glb",
      url: "https://assets.example/b.glb",
    },
  ];
}

describe("DirectorProject deterministic revision", () => {
  it("exports the browser-safe synchronous SHA-256 primitive", () => {
    for (const value of ["", "abc", "导演🎬", "x".repeat(257)]) {
      expect(sha256HexSync(value)).toBe(createHash("sha256").update(value).digest("hex"));
    }
  });

  it("is stable across deep copies and object key insertion order without mutating input", () => {
    const project = createDefaultDirectorProject();
    const before = cloneProject(project);
    const reordered = Object.fromEntries(Object.entries(cloneProject(project)).reverse()) as unknown as DirectorProject;
    reordered.scene = Object.fromEntries(Object.entries(project.scene).reverse()) as DirectorProject["scene"];

    const revision = getDirectorProjectRevision(project);

    expect(getDirectorProjectRevision(cloneProject(project))).toBe(revision);
    expect(getDirectorProjectRevision(reordered)).toBe(revision);
    expect(project).toEqual(before);
    expect(revision).toMatch(/^director-project-revision:v1:sha256:[0-9a-f]{64}$/);
    expect(DIRECTOR_PROJECT_REVISION_CONTRACT).toBe("director-project-revision:v1");
    expect(revision).toBe(
      `${DIRECTOR_PROJECT_REVISION_CONTRACT}:sha256:${createHash("sha256")
        .update(canonicalizeDirectorProjectForRevision(project))
        .digest("hex")}`,
    );
  });

  it("retains array ordering while filtering undefined values", () => {
    const project = createDefaultDirectorProject();
    addTwoAssets(project);
    const reordered = cloneProject(project);
    reordered.assets.reverse();

    expect(getDirectorProjectRevision(reordered)).not.toBe(getDirectorProjectRevision(project));

    const withUndefined = cloneProject(project);
    (withUndefined.scene as unknown as Record<string, unknown>).transient = undefined;
    (withUndefined.assets as Array<DirectorAssetRef | undefined>).splice(1, 0, undefined);
    expect(getDirectorProjectRevision(withUndefined)).toBe(getDirectorProjectRevision(project));
  });

  it("changes when representative scene, object, camera, asset, storyboard, or production truth changes", () => {
    const project = createDefaultDirectorProject();
    addTwoAssets(project);
    project.storyboard = {
      version: 1,
      title: "Board",
      logline: "Original",
      shots: [],
    };
    const baseline = getDirectorProjectRevision(project);

    const mutations: Array<(candidate: DirectorProject) => void> = [
      (candidate) => {
        candidate.scene.backgroundColor = "#ffffff";
      },
      (candidate) => {
        candidate.objects[0]!.transform.position[0] += 1;
      },
      (candidate) => {
        candidate.cameras[0]!.focalLengthMm = 85;
      },
      (candidate) => {
        candidate.assets[0]!.fileName = "renamed.glb";
      },
      (candidate) => {
        candidate.storyboard!.logline = "Changed";
      },
      (candidate) => {
        candidate.production!.takes[0]!.name = "Alternate take";
      },
    ];

    for (const mutate of mutations) {
      const candidate = cloneProject(project);
      mutate(candidate);
      expect(getDirectorProjectRevision(candidate)).not.toBe(baseline);
    }
  });

  it("replaces data and blob payloads with bounded metadata instead of hashing binary bodies", () => {
    const first = createDefaultDirectorProject();
    first.assets = [
      {
        id: "inline-image",
        kind: "panorama",
        sourceType: "image",
        fileName: "sky.png",
        url: `data:image/png;charset=utf-8;base64,${"A".repeat(100_000)}`,
      },
      {
        id: "local-model",
        kind: "prop",
        sourceType: "model",
        fileName: "chair.glb",
        url: "blob:http://localhost/first-session-id",
      },
    ];
    first.cameras[0]!.lastCaptureUrl = "blob:http://localhost/first-preview-id";
    first.cameras[0]!.captures = [
      {
        id: "capture-1",
        index: 1,
        name: "Preview",
        dataUrl: `data:image/webp;base64,${"B".repeat(100_000)}`,
      },
    ];

    const second = cloneProject(first);
    second.assets[0]!.url = "data:image/png;charset=utf-8;base64,DIFFERENT-BINARY-CONTENT";
    second.assets[1]!.url = "blob:http://localhost/second-session-id";
    second.cameras[0]!.lastCaptureUrl = "blob:http://localhost/second-preview-id";
    second.cameras[0]!.captures![0]!.dataUrl = "data:image/webp;base64,OTHER-CAPTURE";

    const canonical = canonicalizeDirectorProjectForRevision(first);
    expect(getDirectorProjectRevision(second)).toBe(getDirectorProjectRevision(first));
    expect(canonical.length).toBeLessThan(10_000);
    expect(canonical).not.toContain("AAAA");
    expect(canonical).not.toContain("first-session-id");
    expect(canonical).toContain('"mediaType":"image/png"');
    expect(canonical).toContain('"parameters":["base64","charset=utf-8"]');

    second.assets[0]!.url = "data:image/jpeg;base64,DIFFERENT-BINARY-CONTENT";
    expect(getDirectorProjectRevision(second)).not.toBe(getDirectorProjectRevision(first));
  });

  it("normalizes negative zero and rejects non-finite numeric scene values", () => {
    const project = createDefaultDirectorProject();
    const negativeZero = cloneProject(project);
    negativeZero.scene.position[0] = -0;
    expect(getDirectorProjectRevision(negativeZero)).toBe(getDirectorProjectRevision(project));

    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const candidate = cloneProject(project);
      candidate.scene.scale = invalid;
      expect(() => getDirectorProjectRevision(candidate)).toThrow("requires a finite number at $.scene.scale");
    }
  });

  it("rejects circular values instead of producing a misleading revision", () => {
    const project = createDefaultDirectorProject();
    const circular = project.objects[0] as DirectorObject & { self?: DirectorObject };
    circular.self = circular;

    expect(() => getDirectorProjectRevision(project)).toThrow("cannot canonicalize a circular reference");
    delete circular.self;
  });
});
