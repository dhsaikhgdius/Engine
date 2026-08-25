// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSafeRelativePath,
  assertReleaseReady,
  buildHuggingFaceAssetUrl,
  installAssetFiles,
  inspectAssetFile,
  isPlaceholderRepository,
  parseAssetManifest,
  resolveAssetTarget,
} from "./director-assets.mjs";

const temporaryRoots = [];

function readExampleManifest() {
  return JSON.parse(readFileSync(resolve(process.cwd(), "assets/manifest.example.json"), "utf8"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createDownloadManifest(payloadSize = 3) {
  return parseAssetManifest({
    manifestVersion: 1,
    release: "test",
    repositories: [
      {
        id: "open",
        provider: "huggingface",
        repoType: "dataset",
        repoId: "director-project/open-assets",
        revision: "1".repeat(40),
        access: "public",
      },
    ],
    licenses: [{ id: "mit", name: "MIT", spdx: "MIT", redistribution: "public" }],
    files: [
      {
        id: "fixture",
        bundle: "fixtures",
        source: { kind: "huggingface", repositoryId: "open", remotePath: "assets/library/fixture.bin" },
        localPath: "assets/library/fixtures/fixture.bin",
        sha256: createHash("sha256").update("abc").digest("hex"),
        size: payloadSize,
        mediaType: "application/octet-stream",
        licenseRef: "mit",
        required: true,
      },
    ],
  });
}

describe("Director asset manifest", () => {
  it("parses the versioned example and keeps redistributable and user-provided assets separate", () => {
    const manifest = parseAssetManifest(readExampleManifest());

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.repositories.map((repository) => repository.access)).toEqual(["public"]);
    expect(manifest.files.map((file) => file.bundle)).toContain("mixamo-characters");
    expect(manifest.files.find((file) => file.id.includes("x-bot"))?.source.kind).toBe("user-provided");
  });

  it("rejects traversal and absolute asset destinations", () => {
    expect(() => assertSafeRelativePath("../outside.glb")).toThrow("repository-relative");
    expect(() => assertSafeRelativePath("/outside.glb")).toThrow("repository-relative");
    expect(() => resolveAssetTarget("/tmp/project", "assets/library/../../outside.glb")).toThrow("repository-relative");
  });

  it("rejects asset destinations outside the runtime asset root", () => {
    const source = readExampleManifest();
    source.files[0].localPath = "assets/manifest.lock.json";
    expect(() => parseAssetManifest(source)).toThrow("unsupported local asset root");
  });

  it("rejects local-only licensed assets when pointed at Hugging Face", () => {
    const source = readExampleManifest();
    source.files[1].source = {
      kind: "huggingface",
      repositoryId: "open",
      remotePath: "assets/library/mixamo-characters/models/x-bot.glb",
    };

    expect(() => parseAssetManifest(source)).toThrow("cannot use a Hugging Face source");
  });

  it("rejects unknown keys at every closed manifest boundary", () => {
    const root = readExampleManifest();
    root.typo = true;
    expect(() => parseAssetManifest(root)).toThrow("asset manifest contains unknown properties: typo");

    const repository = readExampleManifest();
    repository.repositories[0].branch = "main";
    expect(() => parseAssetManifest(repository)).toThrow("repositories[0] contains unknown properties: branch");

    const file = readExampleManifest();
    file.files[0].source.url = "https://example.invalid/asset";
    expect(() => parseAssetManifest(file)).toThrow("files[0].source contains unknown properties: url");
  });

  it("requires real pinned repository values before constructing a download URL", () => {
    const manifest = parseAssetManifest(readExampleManifest());
    expect(isPlaceholderRepository(manifest.repositories[0])).toBe(true);
    expect(() => assertReleaseReady(manifest)).toThrow("not release-ready");
    expect(() => buildHuggingFaceAssetUrl(manifest.repositories[0], "public/model.glb")).toThrow("still a placeholder");

    const repository = {
      ...manifest.repositories[0],
      repoId: "director-project/open-assets",
      revision: "1".repeat(40),
    };
    expect(buildHuggingFaceAssetUrl(repository, "assets/library/models/hero model.glb")).toBe(
      `https://huggingface.co/datasets/director-project/open-assets/resolve/${"1".repeat(40)}/assets/library/models/hero%20model.glb`,
    );
  });

  it("verifies both byte length and SHA-256", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "director-assets-"));
    temporaryRoots.push(projectRoot);
    const payload = Buffer.from("director asset fixture");
    const localPath = "assets/library/fixtures/asset.bin";
    const target = resolve(projectRoot, localPath);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(resolve(projectRoot, "assets/library/fixtures"), { recursive: true });
    writeFileSync(target, payload);
    const file = {
      id: "fixture",
      localPath,
      size: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    };

    await expect(inspectAssetFile(projectRoot, file)).resolves.toMatchObject({ status: "valid" });
    writeFileSync(target, Buffer.from("tampered payload"));
    await expect(inspectAssetFile(projectRoot, file)).resolves.toMatchObject({ status: "size-mismatch" });
  });

  it("rejects a mismatched Content-Length before writing a download", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "director-assets-"));
    temporaryRoots.push(projectRoot);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("abcd", { headers: { "content-length": "4" } })),
    );

    await expect(installAssetFiles(createDownloadManifest(), { projectRoot })).rejects.toThrow(
      "Content-Length mismatch",
    );
    expect(existsSync(resolve(projectRoot, "assets/library/fixtures/fixture.bin"))).toBe(false);
  });

  it("aborts a chunked response as soon as it exceeds the manifest size", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "director-assets-"));
    temporaryRoots.push(projectRoot);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.enqueue(new TextEncoder().encode("d"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );

    await expect(installAssetFiles(createDownloadManifest(), { projectRoot })).rejects.toThrow(
      "exceeded manifest size",
    );
    expect(existsSync(resolve(projectRoot, "assets/library/fixtures/fixture.bin"))).toBe(false);
  });
});
