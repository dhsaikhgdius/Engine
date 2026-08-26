import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DIRECTOR_GODOT_CONNECTOR_OMISSION_CODES, DIRECTOR_GODOT_GATEWAY_OMISSION_CODES } from "@director/dcc-protocol";

/**
 * Host-free goldens over the committed Godot connector sources. These pin the
 * properties a real Godot host cannot cheaply verify in CI: the connector
 * must run on a fresh project with no global class cache (preload-only, no
 * class_name), hard-refuse tampered/unpinned inputs, and emit exactly the
 * structured omission codes shared with the Gateway through
 * `@director/dcc-protocol`.
 */

const repositoryRoot = resolve(__dirname, "..", "..", "..", "..");
const connectorRoot = resolve(repositoryRoot, "integrations", "godot");
const addonDirectory = resolve(connectorRoot, "addons", "director_bridge");

const addonSources = readdirSync(addonDirectory)
  .filter((name) => name.endsWith(".gd"))
  .map((name) => ({ name, text: readFileSync(resolve(addonDirectory, name), "utf8") }));

const allAddonText = addonSources.map(({ text }) => text).join("\n");

describe("Godot connector preload discipline (fresh projects have no class cache)", () => {
  it("declares no class_name anywhere in the addon", () => {
    expect(addonSources.length).toBeGreaterThan(0);
    for (const source of addonSources) {
      expect(source.text, source.name).not.toMatch(/^\s*class_name\s/m);
    }
  });

  it("preloads only literal committed addon paths, and every target exists", () => {
    let preloadCount = 0;
    for (const source of addonSources) {
      for (const match of source.text.matchAll(/preload\(([^)]*)\)/g)) {
        preloadCount += 1;
        const argument = match[1]!.trim();
        // The argument must be a literal string — never a variable — so the
        // load graph is static and reviewable.
        const literal = /^"(res:\/\/addons\/director_bridge\/[a-z_]+\.gd)"$/.exec(argument);
        expect(literal, `${source.name}: preload(${argument})`).not.toBeNull();
        const target = literal![1]!.replace("res://addons/director_bridge/", "");
        expect(existsSync(resolve(addonDirectory, target)), `${source.name} preloads missing ${target}`).toBe(true);
      }
    }
    expect(preloadCount).toBeGreaterThanOrEqual(8);
  });

  it("resolves every inter-module reference through a preload const in the same file", () => {
    for (const source of addonSources) {
      const used = new Set<string>();
      for (const match of source.text.matchAll(/\b(Director[A-Z][A-Za-z]*)\s*\./g)) {
        used.add(match[1]!);
      }
      for (const moduleName of used) {
        expect(source.text, `${source.name} uses ${moduleName} without preloading it`).toMatch(
          new RegExp(`const ${moduleName} := preload\\("res://addons/director_bridge/`),
        );
      }
    }
  });

  it("keeps the connector version identical across connector.json, plugin.cfg, and director_package.gd", () => {
    const manifest = JSON.parse(readFileSync(resolve(connectorRoot, "connector.json"), "utf8")) as {
      version: string;
      entryPoints: Record<string, string>;
    };
    const pluginCfg = readFileSync(resolve(addonDirectory, "plugin.cfg"), "utf8");
    const packageSource = readFileSync(resolve(addonDirectory, "director_package.gd"), "utf8");
    expect(pluginCfg).toContain(`version="${manifest.version}"`);
    expect(packageSource).toContain(`const CONNECTOR_VERSION := "${manifest.version}"`);
    // Every manifest entry point resolves to a committed file.
    for (const entry of Object.values(manifest.entryPoints)) {
      expect(existsSync(resolve(connectorRoot, entry)), `missing entry point ${entry}`).toBe(true);
    }
    expect(pluginCfg).toContain('script="director_bridge.gd"');
  });
});

describe("Godot connector hard-failure source contracts", () => {
  it("rejects package path escapes before touching any file", () => {
    const packageSource = readFileSync(resolve(addonDirectory, "director_package.gd"), "utf8");
    expect(packageSource).toContain('relative_path.begins_with("/") or relative_path.contains("..")');
    expect(packageSource).toContain("Package path escapes the package root");
    // Every referenced file is hash-verified against the manifest.
    expect(packageSource).toContain("FileAccess.get_sha256(absolute)");
    expect(packageSource).toContain("SHA-256 mismatch for %s");
  });

  it("refuses unpinned or tampered animation sidecars", () => {
    const animationSource = readFileSync(resolve(addonDirectory, "director_animation.gd"), "utf8");
    expect(animationSource).toContain("refusing an unpinned bake sidecar");
    expect(animationSource).toContain("Animation bake SHA-256 mismatch");
    // Identity is pinned to the exchange package, not just the bytes.
    expect(animationSource).toContain('bake.get("packageId") != package_id');
    expect(animationSource).toContain('bake.get("sourceRevision") != source_revision');
  });
});

describe("Godot structured omission codes never drift between Gateway and connector", () => {
  it("emits every connector-owned code verbatim from the addon sources", () => {
    for (const code of Object.values(DIRECTOR_GODOT_CONNECTOR_OMISSION_CODES)) {
      expect(allAddonText, `connector code ${code} is missing from the addon`).toContain(`"${code}"`);
    }
  });

  it("declares no connector code outside the shared registry", () => {
    const registered = new Set<string>(Object.values(DIRECTOR_GODOT_CONNECTOR_OMISSION_CODES));
    for (const source of addonSources) {
      for (const match of source.text.matchAll(/^const (?:OMIT|WARN)_[A-Z_]+ := "([a-z0-9_]+)"$/gm)) {
        expect(registered.has(match[1]!), `${source.name} declares unregistered code ${match[1]}`).toBe(true);
      }
    }
  });

  it("keeps the Gateway bake emitting only registry codes", () => {
    const bakeSource = readFileSync(
      resolve(repositoryRoot, "backend", "gateway", "dcc", "godotAnimationBake.ts"),
      "utf8",
    );
    // Shot-level codes come from the shared registry constants, never inline
    // string literals that could drift.
    expect(bakeSource).toContain("DIRECTOR_GODOT_GATEWAY_OMISSION_CODES.shotDuplicateId");
    expect(bakeSource).toContain("DIRECTOR_GODOT_GATEWAY_OMISSION_CODES.shotClampedToPlayback");
    expect(bakeSource).toContain("DIRECTOR_GODOT_GATEWAY_OMISSION_CODES.shotOutsidePlayback");
    expect(bakeSource).toContain("DIRECTOR_GODOT_GATEWAY_OMISSION_CODES.shotCameraNotImported");
    expect(bakeSource).not.toMatch(/warn-and-omit code: shot_/);
    // The bake's omitted-channel vocabulary is itself part of the registry.
    for (const channel of ["pose_values", "motion_blocks", "character_rig"]) {
      expect(Object.values(DIRECTOR_GODOT_GATEWAY_OMISSION_CODES)).toContain(channel);
    }
  });
});
