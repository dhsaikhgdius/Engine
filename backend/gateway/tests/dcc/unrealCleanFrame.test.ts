import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DIRECTOR_UNREAL_CLEAN_FRAME_CONTRACT,
  directorUnrealCleanFrameReceiptSchema,
} from "@director/dcc-protocol";
import {
  runUnrealCleanFrame,
  skippedUnrealCleanFrame,
  type UnrealCleanFrameContext,
} from "../../dcc/unrealCleanFrame";

const REVISION = `director-project-revision:v1:sha256:${"c".repeat(64)}`;

const PNG_BYTES = Buffer.from("89504e470d0a1a0a-fixture-image", "utf8");
const PNG_SHA256 = createHash("sha256").update(PNG_BYTES).digest("hex");

function renderedReceipt(packageId: string, overrides: Record<string, unknown> = {}) {
  return {
    contract: DIRECTOR_UNREAL_CLEAN_FRAME_CONTRACT,
    provider: "unreal",
    status: "rendered",
    packageId,
    sourceRevision: REVISION,
    levelPath: "/Game/Director/Levels/Director_fixture",
    cameraDirectorId: "main-camera",
    frame: 12,
    width: 1_920,
    height: 1_080,
    imagePath: "clean-frame.png",
    imageSha256: PNG_SHA256,
    method: "offscreen_high_res_screenshot",
    hostVersion: "Unreal Engine 5.6.1",
    warnings: [],
    ...overrides,
  };
}

interface HarnessOptions {
  writeReceipt?: (packageId: string) => Record<string, unknown> | null;
  writeImage?: Buffer | null;
  failProcess?: boolean;
}

async function createHarness(options: HarnessOptions = {}) {
  const jobDirectory = await mkdtemp(resolve(tmpdir(), "director-unreal-clean-frame-"));
  const packageDirectory = resolve(jobDirectory, "package");
  await mkdir(packageDirectory, { recursive: true });
  const packageId = randomUUID();
  const observed: string[][] = [];

  const context: UnrealCleanFrameContext = {
    executable: "/fake/UnrealEditor-Cmd",
    projectPath: "/fake/Project.uproject",
    scriptPath: "/fake/Plugins/DirectorBridge/Content/Python/director_headless.py",
    packageDirectory,
    jobDirectory,
    expectedPackageId: packageId,
    expectedSourceRevision: REVISION,
    timeoutMs: 60_000,
    runProcess: async (_executable, args) => {
      observed.push(args);
      if (options.failProcess) throw new Error("editor crashed");
      const receipt = options.writeReceipt ? options.writeReceipt(packageId) : renderedReceipt(packageId);
      if (receipt) {
        await writeFile(resolve(jobDirectory, "clean-frame.json"), JSON.stringify(receipt), "utf8");
      }
      const image = options.writeImage === undefined ? PNG_BYTES : options.writeImage;
      if (image) {
        await writeFile(resolve(jobDirectory, "clean-frame.png"), image);
      }
      return { stdout: "", stderr: "" };
    },
  };
  return { context, packageId, observed };
}

describe("Unreal clean-frame receipt schema (host-free)", () => {
  it("accepts rendered and skipped receipts and exposes the discriminant", () => {
    const rendered = directorUnrealCleanFrameReceiptSchema.parse(renderedReceipt(randomUUID()));
    expect(rendered.status).toBe("rendered");
    const skipped = directorUnrealCleanFrameReceiptSchema.parse(
      skippedUnrealCleanFrame("Unreal Engine is not configured on this Gateway."),
    );
    expect(skipped.status).toBe("skipped");
    expect(skipped).toMatchObject({ provider: "unreal", skipReason: expect.stringMatching(/not configured/) });
  });

  it.each([
    ["a malformed image hash", { imageSha256: "not-a-hash" }],
    ["an absolute image path", { imagePath: "/etc/passwd" }],
    ["a path-traversal image path", { imagePath: "../outside.png" }],
    ["an unknown render method", { method: "viewport_capture" }],
    ["a bogus source revision", { sourceRevision: "rev-1" }],
  ] as const)("rejects %s", (_label, overrides) => {
    expect(directorUnrealCleanFrameReceiptSchema.safeParse(renderedReceipt(randomUUID(), overrides)).success).toBe(
      false,
    );
  });
});

describe("Unreal clean-frame Gateway runner", () => {
  it("runs the fixed render mode offscreen (never nullrhi) and returns the hash-verified receipt", async () => {
    const { context, observed } = await createHarness();
    const receipt = await runUnrealCleanFrame(context, { cameraId: "main-camera", frame: 12 });

    expect(receipt.status).toBe("rendered");
    if (receipt.status === "rendered") {
      expect(receipt.imageSha256).toBe(PNG_SHA256);
      expect(receipt.cameraDirectorId).toBe("main-camera");
    }

    const args = observed[0]!;
    expect(args[0]).toBe("/fake/Project.uproject");
    expect(args).toContain("-RenderOffscreen");
    expect(args).not.toContain("-nullrhi");
    const execCommand = args.find((argument) => argument.startsWith("-ExecCmds=py "))!;
    expect(execCommand).toContain("--mode render");
    expect(execCommand).toContain('--render-camera "main-camera"');
    expect(execCommand).toContain("--render-frame 12");
    expect(execCommand).toMatch(/--report "[^"]*clean-frame\.json"/);
  });

  it("degrades to skipped when the render process fails", async () => {
    const { context } = await createHarness({ failProcess: true });
    const receipt = await runUnrealCleanFrame(context);
    expect(receipt).toMatchObject({ status: "skipped", skipReason: expect.stringMatching(/editor crashed/) });
  });

  it("degrades to skipped when no receipt is written", async () => {
    const { context } = await createHarness({ writeReceipt: () => null });
    const receipt = await runUnrealCleanFrame(context);
    expect(receipt).toMatchObject({ status: "skipped", skipReason: expect.stringMatching(/readable/i) });
  });

  it("passes a connector-side skipped receipt through unchanged", async () => {
    const { context } = await createHarness({
      writeReceipt: () => skippedUnrealCleanFrame("Level /Game/Director/Levels/Director_fixture was not found."),
      writeImage: null,
    });
    const receipt = await runUnrealCleanFrame(context);
    expect(receipt).toMatchObject({ status: "skipped", skipReason: expect.stringMatching(/was not found/) });
  });

  it("refuses a receipt that references a different package", async () => {
    const { context } = await createHarness({ writeReceipt: () => renderedReceipt(randomUUID()) });
    const receipt = await runUnrealCleanFrame(context);
    expect(receipt).toMatchObject({ status: "skipped", skipReason: expect.stringMatching(/does not reference/) });
  });

  it("refuses image bytes that do not match the pinned SHA-256", async () => {
    const { context } = await createHarness({ writeImage: Buffer.from("tampered bytes") });
    const receipt = await runUnrealCleanFrame(context);
    expect(receipt).toMatchObject({ status: "skipped", skipReason: expect.stringMatching(/SHA-256/) });
  });

  it("refuses a missing image file", async () => {
    const { context } = await createHarness({ writeImage: null });
    const receipt = await runUnrealCleanFrame(context);
    expect(receipt).toMatchObject({ status: "skipped", skipReason: expect.stringMatching(/missing/i) });
  });
});
