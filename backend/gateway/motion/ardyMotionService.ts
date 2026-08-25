import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Gateway bridge for NVIDIA ARDY (nv-tlabs/ardy, Apache-2.0) text-to-motion
 * generation. It drives the upstream repo's own `scripts/generate.py` CLI in
 * a configured checkout — locally or over SSH — and exposes the generated
 * `.npz` motion (posed_joints / local_rot_mats / root_positions / fps) to the
 * workbench. Nothing here reimplements the model; an unconfigured bridge is
 * an expected state the UI must present as such.
 */

export const ardyGenerateRequestSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(600),
  durationS: z.number().finite().min(1).max(30).default(5),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,80}$/)
    .optional(),
});

export type ArdyGenerateRequest = z.infer<typeof ardyGenerateRequestSchema>;

export type ArdyMotionEvent =
  | { event: "status"; message: string }
  | { event: "done"; jobId: string; motionUrl: string; bytes: number; model: string }
  | { event: "error"; message: string };

export type ArdyMotionServiceOptions = {
  config: {
    repo?: string;
    python: string;
    sshHost?: string;
    model: string;
    timeoutMs: number;
  };
  dataDirectory: string;
  spawnImpl?: typeof spawn;
};

const JOB_ID_PATTERN = /^motion-[a-z0-9-]{8,80}$/;

/** POSIX single-quote escaping for the remote side of an ssh invocation.
 * Local runs never go through a shell; only the ssh remote command line does. */
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export class ArdyMotionService {
  private readonly spawnImpl: typeof spawn;
  /** jobId -> verified absolute npz path; only ever populated after this
   * process generated the file and confirmed it on disk. */
  private readonly motions = new Map<string, string>();

  constructor(private readonly options: ArdyMotionServiceOptions) {
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  get configured() {
    return Boolean(this.options.config.repo);
  }

  status() {
    return {
      configured: this.configured,
      remote: Boolean(this.options.config.sshHost),
      model: this.options.config.model,
    };
  }

  resolveMotionPath(jobId: string) {
    if (!JOB_ID_PATTERN.test(jobId)) return null;
    return this.motions.get(jobId) ?? null;
  }

  /**
   * Run one text-to-motion generation. Progress, completion, and failure are
   * reported through `onEvent`; the returned promise resolves after the
   * terminal event has been emitted. `signal` aborts the child process group.
   */
  async generate(rawRequest: unknown, onEvent: (event: ArdyMotionEvent) => void, signal?: AbortSignal) {
    const request = ardyGenerateRequestSchema.parse(rawRequest);
    const config = this.options.config;
    if (!config.repo) {
      onEvent({
        event: "error",
        message: "ARDY is not configured; set DIRECTOR_ARDY_REPO to an ardy checkout or run npm run setup:ardy.",
      });
      return;
    }
    const model = request.model ?? config.model;
    const jobId = `motion-${randomUUID()}`;
    const jobDirectory = resolve(this.options.dataDirectory, "motion-jobs", jobId);
    await mkdir(jobDirectory, { recursive: true });
    const outputStem = resolve(jobDirectory, "motion");
    const outputPath = `${outputStem}.npz`;

    const generateArgs = [
      "scripts/generate.py",
      request.prompt,
      "--model",
      model,
      "--duration",
      String(request.durationS),
      ...(request.seed === undefined ? [] : ["--seed", String(request.seed)]),
      "--output",
      outputStem,
    ];

    onEvent({ event: "status", message: `Generating ${request.durationS}s of motion with ARDY ${model}…` });
    try {
      if (config.sshHost) {
        // The remote run writes to a remote stem; the npz is copied back after.
        const remoteStem = `/tmp/director-ardy-${jobId}`;
        const remoteArgs = generateArgs.slice(0, -1).map(shellQuote).concat(shellQuote(remoteStem));
        const command = `cd ${shellQuote(config.repo)} && ${shellQuote(config.python)} ${remoteArgs.join(" ")}`;
        await this.runChild(
          "ssh",
          ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", config.sshHost, command],
          onEvent,
          signal,
        );
        onEvent({ event: "status", message: "Copying generated motion from the ARDY host…" });
        await this.runChild(
          "scp",
          ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `${config.sshHost}:${remoteStem}.npz`, outputPath],
          onEvent,
          signal,
        );
      } else {
        await this.runChild(config.python, generateArgs, onEvent, signal, config.repo);
      }
      const fileInfo = await stat(outputPath);
      if (!fileInfo.isFile() || fileInfo.size === 0) {
        throw new Error("ARDY finished without writing a motion npz");
      }
      this.motions.set(jobId, outputPath);
      onEvent({
        event: "done",
        jobId,
        motionUrl: `/api/motion/ardy/motions/${jobId}`,
        bytes: fileInfo.size,
        model,
      });
    } catch (error) {
      onEvent({
        event: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private runChild(
    command: string,
    args: string[],
    onEvent: (event: ArdyMotionEvent) => void,
    signal?: AbortSignal,
    cwd?: string,
  ) {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const child: ChildProcess = this.spawnImpl(command, args, {
        ...(cwd ? { cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const timeout = setTimeout(() => {
        killGroup(child);
        rejectPromise(new Error(`ARDY generation exceeded ${this.options.config.timeoutMs}ms and was terminated`));
      }, this.options.config.timeoutMs);
      const onAbort = () => {
        killGroup(child);
        rejectPromise(new Error("ARDY generation was cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const forwardLines = (() => {
        let buffer = "";
        return (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) onEvent({ event: "status", message: line.slice(0, 400) });
            newline = buffer.indexOf("\n");
          }
        };
      })();
      child.stdout?.on("data", forwardLines);
      const stderrTail: string[] = [];
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrTail.push(text);
        while (stderrTail.length > 40) stderrTail.shift();
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        rejectPromise(new Error(`Failed to launch ${command}: ${error.message}`));
      });
      child.once("exit", (code, exitSignal) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (code === 0) {
          resolvePromise();
          return;
        }
        const detail = stderrTail.join("").trim().split("\n").slice(-6).join("\n");
        rejectPromise(
          new Error(
            `${command} exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}${detail ? `: ${detail}` : ""}`,
          ),
        );
      });
    });
  }
}

function killGroup(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 3_000).unref();
}
