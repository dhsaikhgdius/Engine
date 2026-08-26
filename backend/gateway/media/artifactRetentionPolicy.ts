import { z } from "zod";
import {
  isTerminalProductionJobStatus,
  productionJobKindSchema,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import { PRODUCTION_JOB_ARTIFACT_PREFIX } from "./artifactReachabilityGc";

/**
 * Configurable retention policy for the artifact storage backend.
 *
 * The policy decides two things on top of reachability GC:
 *
 * 1. Which *terminal* job artifacts age out: an expiry rule scoped by job
 *    kind and terminal status marks artifact bytes sweepable once the job
 *    finished more than `retainDays` ago. Without rules nothing reachable
 *    ever expires, which is exactly the pre-policy behavior.
 * 2. Which objects are under legal hold: held keys are never swept, no
 *    matter what reachability or expiry say.
 *
 * The default policy is deliberately conservative: 24 h minimum age, no
 * expiry rules, no legal holds — byte-compatible with the previous GC.
 */

/** One expiry rule: terminal jobs matching kind/status age out after `retainDays`. */
export const artifactRetentionRuleSchema = z.strictObject({
  /** Job kinds the rule applies to; empty/omitted means every kind. */
  jobKinds: z.array(productionJobKindSchema).max(32).optional(),
  /** Terminal statuses the rule applies to; omitted means every terminal status. */
  statuses: z.array(z.enum(["succeeded", "failed", "cancelled"])).min(1).max(3).optional(),
  /** Days a matching terminal job's artifact bytes stay retained after it finished. */
  retainDays: z.number().int().min(1).max(3650),
});

/** Legal-hold declarations; held keys are never swept. */
export const artifactLegalHoldSchema = z.strictObject({
  /** Exact storage keys under hold. */
  keys: z.array(z.string().min(1).max(1024)).max(256).default([]),
  /** Key prefixes under hold. */
  keyPrefixes: z.array(z.string().min(1).max(1024)).max(64).default([]),
  /** Production job ids whose whole artifact tree is under hold. */
  jobIds: z.array(z.string().min(1).max(240)).max(256).default([]),
});

/** The full artifact retention policy. */
export const artifactRetentionPolicySchema = z.strictObject({
  contract: z.literal("director-artifact-retention-policy-v1").default("director-artifact-retention-policy-v1"),
  /** Objects younger than this are always kept, whatever the rules say. */
  minimumAgeHours: z.number().int().min(1).max(24 * 365).default(24),
  /** Terminal-job artifact expiry rules; empty means nothing reachable ever expires. */
  rules: z.array(artifactRetentionRuleSchema).max(32).default([]),
  legalHold: artifactLegalHoldSchema.default({ keys: [], keyPrefixes: [], jobIds: [] }),
});

/** A validated artifact retention policy. */
export type ArtifactRetentionPolicy = z.infer<typeof artifactRetentionPolicySchema>;
/** One validated expiry rule. */
export type ArtifactRetentionRule = z.infer<typeof artifactRetentionRuleSchema>;

/** The conservative default policy: 24 h minimum age, no expiry, no holds. */
export const DEFAULT_ARTIFACT_RETENTION_POLICY: ArtifactRetentionPolicy = artifactRetentionPolicySchema.parse({});

/** Where the resolved policy came from. */
export type ArtifactRetentionPolicySource = "default" | "environment";

/** A policy together with its provenance, for the health surface. */
export interface ResolvedArtifactRetentionPolicy {
  policy: ArtifactRetentionPolicy;
  source: ArtifactRetentionPolicySource;
}

/**
 * Resolves the retention policy from the environment.
 *
 * `DIRECTOR_ARTIFACT_RETENTION_JSON` supplies the full policy document;
 * `DIRECTOR_ARTIFACT_RETENTION_MIN_AGE_HOURS` overrides only the minimum
 * age. Unset variables yield the conservative default policy.
 *
 * @param environment - Environment map; defaults to `process.env`.
 * @returns The validated policy and its source.
 * @throws When a configured value is malformed — a misconfigured retention
 *   policy must fail loudly at startup, never silently fall back.
 */
export function resolveArtifactRetentionPolicy(
  environment: Record<string, string | undefined> = process.env,
): ResolvedArtifactRetentionPolicy {
  const rawJson = environment.DIRECTOR_ARTIFACT_RETENTION_JSON?.trim();
  const rawMinAge = environment.DIRECTOR_ARTIFACT_RETENTION_MIN_AGE_HOURS?.trim();

  let policy = DEFAULT_ARTIFACT_RETENTION_POLICY;
  let source: ArtifactRetentionPolicySource = "default";
  if (rawJson) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawJson);
    } catch (error) {
      throw new Error(
        `DIRECTOR_ARTIFACT_RETENTION_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = artifactRetentionPolicySchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error(`DIRECTOR_ARTIFACT_RETENTION_JSON is invalid: ${z.prettifyError(parsed.error)}`);
    }
    policy = parsed.data;
    source = "environment";
  }
  if (rawMinAge) {
    const minimumAgeHours = artifactRetentionPolicySchema.shape.minimumAgeHours.parse(Number(rawMinAge));
    policy = { ...policy, minimumAgeHours };
    source = "environment";
  }
  return { policy, source };
}

function ruleMatches(rule: ArtifactRetentionRule, job: ProductionJobRecord): boolean {
  if (rule.jobKinds?.length && !rule.jobKinds.includes(job.kind)) return false;
  if (rule.statuses && !rule.statuses.includes(job.status as "succeeded" | "failed" | "cancelled")) return false;
  return true;
}

function jobFinishedAtMs(job: ProductionJobRecord): number {
  const finishedAt = job.attempts.at(-1)?.timestamps.finishedAt ?? job.updatedAt;
  return new Date(finishedAt).getTime();
}

/** Why one artifact key is retention-expired, for the reviewable plan/audit. */
export interface RetentionExpiredArtifact {
  jobId: string;
  jobKind: ProductionJobRecord["kind"];
  jobStatus: ProductionJobRecord["status"];
  finishedAt: string;
  /** The retention window (days) that expired; the longest matching rule wins. */
  retainDays: number;
}

/**
 * Computes the artifact storage keys whose terminal retention window has
 * passed. Only artifacts of terminal jobs can expire, and when several rules
 * match a job the longest window wins, so overlapping rules can only extend
 * retention, never shorten it.
 *
 * @param jobs - Every durable production job record.
 * @param policy - The validated retention policy.
 * @param nowMs - The evaluation instant in epoch milliseconds.
 * @returns Expired artifact keys with the evidence for the plan/audit.
 */
export function collectRetentionExpiredArtifactKeys(
  jobs: readonly ProductionJobRecord[],
  policy: ArtifactRetentionPolicy,
  nowMs: number,
): Map<string, RetentionExpiredArtifact> {
  const expired = new Map<string, RetentionExpiredArtifact>();
  if (!policy.rules.length) return expired;
  for (const job of jobs) {
    if (!isTerminalProductionJobStatus(job.status)) continue;
    const matching = policy.rules.filter((rule) => ruleMatches(rule, job));
    if (!matching.length) continue;
    const retainDays = Math.max(...matching.map((rule) => rule.retainDays));
    const finishedAtMs = jobFinishedAtMs(job);
    if (!Number.isFinite(finishedAtMs) || nowMs - finishedAtMs < retainDays * 24 * 60 * 60_000) continue;
    for (const artifact of job.artifacts) {
      expired.set(`${PRODUCTION_JOB_ARTIFACT_PREFIX}${job.id}/attempts/${artifact.attemptId}/${artifact.fileName}`, {
        jobId: job.id,
        jobKind: job.kind,
        jobStatus: job.status,
        finishedAt: new Date(finishedAtMs).toISOString(),
        retainDays,
      });
    }
  }
  return expired;
}

/**
 * Builds the legal-hold predicate for GC planning from the policy's exact
 * keys, key prefixes, and per-job holds.
 *
 * @param policy - The validated retention policy.
 * @returns A predicate that is true for held keys.
 */
export function legalHoldPredicate(policy: ArtifactRetentionPolicy): (key: string) => boolean {
  const heldKeys = new Set(policy.legalHold.keys);
  const heldPrefixes = [
    ...policy.legalHold.keyPrefixes,
    ...policy.legalHold.jobIds.map((jobId) => `${PRODUCTION_JOB_ARTIFACT_PREFIX}${jobId}/`),
  ];
  return (key) => heldKeys.has(key) || heldPrefixes.some((prefix) => key.startsWith(prefix));
}
