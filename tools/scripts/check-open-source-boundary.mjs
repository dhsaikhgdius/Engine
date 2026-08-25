import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { extname } from "node:path";

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENTATION_IMAGE_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_EXTENSIONS = new Set([
  ".7z",
  ".blend",
  ".ckpt",
  ".dae",
  ".db",
  ".engine",
  ".fbx",
  ".flac",
  ".glb",
  ".gguf",
  ".jks",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".obj",
  ".onnx",
  ".ogg",
  ".p12",
  ".pem",
  ".pfx",
  ".plan",
  ".pt",
  ".pth",
  ".rar",
  ".safetensors",
  ".sqlite",
  ".stl",
  ".tar",
  ".tflite",
  ".tgz",
  ".usdc",
  ".usdz",
  ".wav",
  ".webm",
  ".zip",
]);
const IMAGE_EXTENSIONS = new Set([".avif", ".exr", ".hdr", ".jpeg", ".jpg", ".ktx", ".ktx2", ".png", ".webp"]);
const REQUIRED_SOURCE_METADATA = [
  "assets/manifest.schema.json",
  "assets/manifest.example.json",
  "assets/library/director-characters/catalog.json",
  "assets/library/flick-stage-props/catalog.json",
  "assets/library/mixamo-animations/catalog.json",
  "assets/library/mixamo-characters/catalog.json",
  "assets/library/model-library/LICENSE",
  "assets/library/model-library/README.md",
  "assets/library/model-library/SHA256SUMS",
  "assets/library/models/storyai-open-mannequin.LICENSE.md",
];
const MUST_BE_IGNORED = [
  "data/dcc-jobs/example/scene.blend",
  "data/director-production.json",
  "assets/library/mixamo-characters/models/x-bot.glb",
  "assets/library/flick-stage-props/thumbnails/animals/cat.webp",
  "assets/library/model-library/便利生活/ATM_low.fbx",
  "assets/library/model-library/便利生活/缩略图/自动取款机.svg",
  ".external/mixamo-downloader/downloads/X_Bot.fbx",
  "docs/site/src/content/docs/engineering/reference/flick-stage-concept.png",
];

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isIgnored(path) {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "-q", "--", path], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const candidates = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
const failures = [];

for (const path of candidates) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    continue;
  }
  if (!stats.isFile()) continue;
  const lower = path.toLowerCase();
  const extension = extname(lower);
  const basename = lower.split("/").at(-1);

  if (
    basename === ".env" ||
    (basename.startsWith(".env.") && !basename.endsWith(".example")) ||
    basename.endsWith(".token") ||
    basename === "credentials.json" ||
    basename === "service-account.json" ||
    basename === "id_rsa" ||
    basename === "id_ed25519"
  ) {
    failures.push(`${path}: credential-shaped file is eligible for Git`);
  }
  if (FORBIDDEN_EXTENSIONS.has(extension) || /\.blend\d+$/.test(lower)) {
    failures.push(`${path}: binary asset/runtime extension ${extension || "(blend backup)"} is eligible for Git`);
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    const documentationImage =
      lower.startsWith("docs/research/") ||
      lower.startsWith("docs/site/src/content/docs/") ||
      lower.startsWith("docs/site/src/assets/") ||
      lower === "tools/e2e/fixtures/director-e2e-red.png" ||
      lower.startsWith("tools/e2e/render-golden.spec.ts-snapshots/");
    if (!documentationImage) failures.push(`${path}: image asset must be externalized or documented as a docs image`);
    else if (stats.size > MAX_DOCUMENTATION_IMAGE_BYTES) {
      failures.push(`${path}: documentation image exceeds 2 MiB (${stats.size} bytes)`);
    }
  }
  if (stats.size > MAX_SOURCE_BYTES)
    failures.push(`${path}: source-repository file exceeds 5 MiB (${stats.size} bytes)`);
}

for (const path of REQUIRED_SOURCE_METADATA) {
  if (isIgnored(path)) failures.push(`${path}: required catalog/schema/license metadata is ignored`);
}
for (const path of MUST_BE_IGNORED) {
  if (!isIgnored(path)) failures.push(`${path}: asset/runtime probe is not ignored`);
}

if (failures.length > 0) {
  console.error("Open-source repository boundary failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Open-source repository boundary passed: ${candidates.length} source/metadata candidates checked; runtime assets remain external.`,
  );
}
