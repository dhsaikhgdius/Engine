import { describe, expect, it } from "vitest";
import {
  PRODUCTION_JOB_CONTRACT_VERSION,
  hashInputFingerprint,
  productionJobRecordSchema,
  type ProductionJobInput,
  type ProductionJobKind,
  type ProductionJobRecord,
  type ProductionJobStatus,
} from "../../../../packages/protocol/src/productionJobProtocol";
import {
  DEFAULT_ARTIFACT_RETENTION_POLICY,
  artifactRetentionPolicySchema,
  collectRetentionExpiredArtifactKeys,
  legalHoldPredicate,
  resolveArtifactRetentionPolicy,
} from "../../media/artifactRetentionPolicy";

const NOW = new Date("2026-08-25T12:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60_000;

function job(
  id: string,
  status: ProductionJobStatus,
  kind: ProductionJobKind,
  input: ProductionJobInput,
  options: { finishedAt?: string; artifactFileName?: string } = {},
): ProductionJobRecord {
  const fingerprint = hashInputFingerprint(kind, input);
  const attemptId = `${id}-attempt-1`;
  const createdAt = "2026-08-01T00:00:00.000Z";
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
  const finishedAt = options.finishedAt ?? createdAt;
  const artifacts = options.artifactFileName
    ? [
        {
          id: `${attemptId}-artifact-1`,
          attemptId,
          role: "primary",
          mimeType: "video/mp4",
          fileName: options.artifactFileName,
          sha256: "c".repeat(64),
          bytes: 10,
          createdAt,
        },
      ]
    : [];
  return productionJobRecordSchema.parse({
    contractVersion: PRODUCTION_JOB_CONTRACT_VERSION,
    id,
    kind,
    status,
    progress: status === "succeeded" ? 1 : 0,
    inputFingerprint: fingerprint,
    idempotencyKey: `${kind}:${id}`,
    input,
    attempts: [
      {
        id: attemptId,
        number: 1,
        status,
        provider: "director.test",
        inputFingerprint: fingerprint,
        idempotencyKey: `${kind}:${id}`,
        sourceRevisions: {},
        timestamps: {
          createdAt,
          startedAt: status === "queued" ? undefined : createdAt,
          outcomeUnknownAt: status === "outcome_unknown" || status === "reconciling" ? createdAt : undefined,
          reconciliationStartedAt: status === "reconciling" ? createdAt : undefined,
          finishedAt: terminal ? finishedAt : undefined,
        },
        artifacts,
      },
    ],
    createdAt,
    updatedAt: finishedAt,
    artifacts,
  });
}

const proxyInput = { sourceMediaId: "media-1" } as ProductionJobInput;

describe("artifactRetentionPolicy", () => {
  it("defaults to the conservative pre-policy behavior", () => {
    const resolved = resolveArtifactRetentionPolicy({});
    expect(resolved.source).toBe("default");
    expect(resolved.policy).toEqual(DEFAULT_ARTIFACT_RETENTION_POLICY);
    expect(resolved.policy.minimumAgeHours).toBe(24);
    expect(resolved.policy.rules).toEqual([]);
    expect(
      collectRetentionExpiredArtifactKeys(
        [job("job-old", "succeeded", "media.proxy", proxyInput, { artifactFileName: "proxy.mp4" })],
        resolved.policy,
        NOW + 3650 * DAY_MS,
      ).size,
    ).toBe(0);
  });

  it("resolves the full policy and the min-age override from the environment", () => {
    const resolved = resolveArtifactRetentionPolicy({
      DIRECTOR_ARTIFACT_RETENTION_JSON: JSON.stringify({
        minimumAgeHours: 48,
        rules: [{ jobKinds: ["media.proxy"], statuses: ["succeeded"], retainDays: 30 }],
        legalHold: { jobIds: ["job-held"] },
      }),
    });
    expect(resolved.source).toBe("environment");
    expect(resolved.policy.minimumAgeHours).toBe(48);
    expect(resolved.policy.rules).toEqual([{ jobKinds: ["media.proxy"], statuses: ["succeeded"], retainDays: 30 }]);
    expect(resolved.policy.legalHold.jobIds).toEqual(["job-held"]);

    const minAgeOnly = resolveArtifactRetentionPolicy({ DIRECTOR_ARTIFACT_RETENTION_MIN_AGE_HOURS: "72" });
    expect(minAgeOnly.source).toBe("environment");
    expect(minAgeOnly.policy.minimumAgeHours).toBe(72);
    expect(minAgeOnly.policy.rules).toEqual([]);
  });

  it("fails loudly on malformed configuration instead of silently falling back", () => {
    expect(() => resolveArtifactRetentionPolicy({ DIRECTOR_ARTIFACT_RETENTION_JSON: "{not json" })).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      resolveArtifactRetentionPolicy({
        DIRECTOR_ARTIFACT_RETENTION_JSON: JSON.stringify({ rules: [{ retainDays: 0 }] }),
      }),
    ).toThrow(/invalid/);
    expect(() => resolveArtifactRetentionPolicy({ DIRECTOR_ARTIFACT_RETENTION_MIN_AGE_HOURS: "0" })).toThrow();
  });

  it("expires only matching terminal jobs, and the longest matching window wins", () => {
    const policy = artifactRetentionPolicySchema.parse({
      rules: [
        { jobKinds: ["media.proxy"], retainDays: 7 },
        { statuses: ["succeeded"], retainDays: 30 },
      ],
    });
    const finishedAt = new Date(NOW - 10 * DAY_MS).toISOString();
    const jobs = [
      // media.proxy + succeeded matches both rules; the 30-day window governs.
      job("job-both", "succeeded", "media.proxy", proxyInput, { finishedAt, artifactFileName: "proxy.mp4" }),
      // media.proxy + failed matches only the 7-day rule and is 10 days old.
      job("job-failed", "failed", "media.proxy", proxyInput, { finishedAt, artifactFileName: "partial.mp4" }),
      // Non-matching kind and non-terminal jobs never expire.
      job(
        "job-other-kind",
        "failed",
        "media.transcode",
        { sourceMediaId: "media-2", targetMimeType: "video/mp4" } as ProductionJobInput,
        { finishedAt, artifactFileName: "out.mp4" },
      ),
      job("job-running", "running", "media.proxy", proxyInput),
    ];

    const expired = collectRetentionExpiredArtifactKeys(jobs, policy, NOW);
    expect([...expired.keys()]).toEqual([
      "production-jobs/job-failed/attempts/job-failed-attempt-1/partial.mp4",
    ]);
    expect(expired.get("production-jobs/job-failed/attempts/job-failed-attempt-1/partial.mp4")).toMatchObject({
      jobId: "job-failed",
      jobKind: "media.proxy",
      jobStatus: "failed",
      retainDays: 7,
    });

    // 31 days later the succeeded job's 30-day window has passed too.
    const later = collectRetentionExpiredArtifactKeys(jobs, policy, NOW + 21 * DAY_MS);
    expect(later.has("production-jobs/job-both/attempts/job-both-attempt-1/proxy.mp4")).toBe(true);
  });

  it("builds the legal-hold predicate from keys, prefixes, and job ids", () => {
    const policy = artifactRetentionPolicySchema.parse({
      legalHold: {
        keys: ["media-transcode-inputs/aa.bin"],
        keyPrefixes: ["media-transcode-inputs/bb"],
        jobIds: ["job-held"],
      },
    });
    const held = legalHoldPredicate(policy);
    expect(held("media-transcode-inputs/aa.bin")).toBe(true);
    expect(held("media-transcode-inputs/bb123.bin")).toBe(true);
    expect(held("production-jobs/job-held/attempts/a/x.mp4")).toBe(true);
    expect(held("production-jobs/job-held-2/attempts/a/x.mp4")).toBe(false);
    expect(held("media-transcode-inputs/cc.bin")).toBe(false);
  });
});
