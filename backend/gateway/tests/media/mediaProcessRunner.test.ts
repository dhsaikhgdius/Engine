import { describe, expect, it } from "vitest";
import { runMediaProcess } from "../../media/mediaProcessRunner";

// These tests exercise the real spawn wrapper with the node binary itself;
// they never require ffmpeg.
describe("runMediaProcess", () => {
  it("captures exit codes with bounded stdout head and stderr tail", async () => {
    const result = await runMediaProcess(
      process.execPath,
      [
        "-e",
        'process.stdout.write("a".repeat(5000)); process.stderr.write("b".repeat(5000) + "END"); process.exit(3);',
      ],
      { timeoutMs: 8_000, maxStdoutChars: 100, maxStderrChars: 50 },
    );

    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("a".repeat(100));
    expect(result.stderr.endsWith("END")).toBe(true);
    expect(result.stderr).toHaveLength(50);
  });

  it("terminates a hung process with SIGTERM on timeout", async () => {
    const result = await runMediaProcess(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      timeoutMs: 200,
      killGracePeriodMs: 2_000,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
  });

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    const result = await runMediaProcess(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { timeoutMs: 200, killGracePeriodMs: 200 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  it("rejects with the spawn error when the binary does not exist", async () => {
    await expect(
      runMediaProcess("/definitely/not/a/real/ffmpeg-binary", ["-version"], { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
