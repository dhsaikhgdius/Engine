import { z } from "zod";
import { stableLexicalJson } from "./stableJson";

import { sha256HexSync } from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectRevision";
import { strictKind, strictOperation } from "./strictProtocolVariant";

/** Protocol version contract stamped on every immutable artifact version record. */
export const PRODUCTION_ARTIFACT_VERSION_CONTRACT = "director-artifact-version-v1" as const;
/** Protocol version contract stamped on every immutable promotion record. */
export const PRODUCTION_ARTIFACT_PROMOTION_CONTRACT = "director-artifact-promotion-v1" as const;
/** Protocol version contract stamped on every immutable approval record. */
export const PRODUCTION_APPROVAL_CONTRACT = "director-production-approval-v1" as const;

const idSchema = z.string().trim().min(1).max(240);
const nameSchema = z.string().trim().min(1).max(512);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const fingerprintSchema = z.string().trim().min(16).max(512);
const isoDateSchema = z.string().datetime({ offset: true });
const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => value !== "." && value !== ".." && !/[\\/\0]/u.test(value), {
    message: "fileName must be a safe base name without path separators",
  });

/** Zod's readonly wrapper is shallow; evidence records must not expose mutable nested state. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Broad media categories for production artifacts; drives routing, preview, and export decisions. */
export const productionArtifactKindSchema = z.enum([
  "image",
  "video",
  "audio",
  "model",
  "document",
  "archive",
  "other",
]);

/** Content-addressable identity for one artifact's binary payload. The sha256 is the canonical key. */
export const productionArtifactContentSchema = z
  .strictObject({
    sha256: sha256Schema,
    bytes: z.number().int().nonnegative(),
    mimeType: z.string().trim().min(1).max(240),
    fileName: fileNameSchema,
  })
  .readonly();

const providerSnapshotSchema = z
  .strictObject({
    provider: z.string().trim().min(1).max(160),
    model: z.string().trim().min(1).max(240).optional(),
    configurationFingerprint: fingerprintSchema.optional(),
    seed: z.number().int().safe().nullable().optional(),
  })
  .readonly();

/** Discriminated origin of an artifact: job output, stage capture, import, DCC return, or upload. */
export const productionArtifactProvenanceSchema = z.discriminatedUnion("kind", [
  strictKind("job", {
    jobId: idSchema,
    attemptId: idSchema,
    inputFingerprint: fingerprintSchema,
    provider: providerSnapshotSchema.optional(),
  }),
  strictKind("capture", {
    projectRevision: fingerprintSchema,
    sceneId: idSchema,
    cameraId: idSchema,
    frame: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.enum(["import", "dcc-return"]),
    receiptId: idSchema,
    sourceFingerprint: fingerprintSchema,
    adapter: z.string().trim().min(1).max(160),
  }),
  strictKind("upload", { sourceFingerprint: fingerprintSchema }),
]);

/** Optional media dimensions, duration, frame rate, and audio properties probed from the artifact. */
export const productionArtifactMediaMetadataSchema = z
  .strictObject({
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationUs: z.number().int().nonnegative().optional(),
    frameCount: z.number().int().nonnegative().optional(),
    frameRate: z
      .strictObject({
        numerator: z.number().int().positive(),
        denominator: z.number().int().positive(),
      })
      .optional(),
    channels: z.number().int().positive().optional(),
    sampleRate: z.number().int().positive().optional(),
  })
  .readonly();

const productionArtifactVersionFields = {
  contract: z.literal(PRODUCTION_ARTIFACT_VERSION_CONTRACT),
  versionId: idSchema,
  artifactId: idSchema,
  ordinal: z.number().int().positive(),
  immutable: z.literal(true),
  kind: productionArtifactKindSchema,
  name: nameSchema,
  content: productionArtifactContentSchema,
  provenance: productionArtifactProvenanceSchema,
  sourceVersionIds: z.array(idSchema).max(128).default([]),
  metadata: productionArtifactMediaMetadataSchema.optional(),
  createdAt: isoDateSchema,
  createdBy: idSchema,
} satisfies z.ZodRawShape;

function validateArtifactLineage(
  value: { readonly versionId: string; readonly sourceVersionIds: readonly string[] },
  context: z.RefinementCtx,
): void {
  if (new Set(value.sourceVersionIds).size !== value.sourceVersionIds.length) {
    context.addIssue({ code: "custom", path: ["sourceVersionIds"], message: "sourceVersionIds must be unique" });
  }
  if (value.sourceVersionIds.includes(value.versionId)) {
    context.addIssue({
      code: "custom",
      path: ["sourceVersionIds"],
      message: "an artifact version cannot derive from itself",
    });
  }
}

/** Input shape for creating an artifact version — no recordFingerprint, validated by the caller. */
export const productionArtifactVersionInputSchema = z
  .strictObject(productionArtifactVersionFields)
  .superRefine(validateArtifactLineage)
  .readonly();

/** Immutable artifact version record with a self-validating content-hash fingerprint. */
export const productionArtifactVersionSchema = z
  .strictObject({
    ...productionArtifactVersionFields,
    recordFingerprint: z.string().regex(/^artifact-version:v1:sha256:[0-9a-f]{64}$/),
  })
  .superRefine((value, context) => {
    validateArtifactLineage(value, context);
    const sortedSources = [...value.sourceVersionIds].sort();
    if (sortedSources.some((sourceVersionId, index) => sourceVersionId !== value.sourceVersionIds[index])) {
      context.addIssue({
        code: "custom",
        path: ["sourceVersionIds"],
        message: "sourceVersionIds must use canonical sorted order",
      });
    }
    const { recordFingerprint: _recordFingerprint, ...input } = value;
    if (value.recordFingerprint !== getProductionArtifactVersionFingerprint(input)) {
      context.addIssue({
        code: "custom",
        path: ["recordFingerprint"],
        message: "recordFingerprint does not match the immutable artifact version record",
      });
    }
  })
  .readonly()
  .transform(deepFreeze);

/** A workspace slot to which an artifact version is promoted, e.g. canvas:scene1:hero. */
export const productionPromotionTargetSchema = z
  .strictObject({
    workspace: z.enum(["canvas", "stage", "video", "delivery"]),
    ownerId: idSchema,
    slot: z.string().trim().min(1).max(160),
  })
  .readonly();

const productionArtifactPromotionFields = {
  contract: z.literal(PRODUCTION_ARTIFACT_PROMOTION_CONTRACT),
  promotionId: idSchema,
  target: productionPromotionTargetSchema,
  artifactId: idSchema,
  versionId: idSchema,
  artifactFingerprint: z.string().regex(/^artifact-version:v1:sha256:[0-9a-f]{64}$/),
  previousVersionId: idSchema.nullable(),
  approvalIds: z.array(idSchema).max(64).default([]),
  promotedAt: isoDateSchema,
  promotedBy: idSchema,
} satisfies z.ZodRawShape;

/** Immutable promotion record binding an artifact version to a workspace slot with optional approvals. */
export const productionArtifactPromotionSchema = z
  .strictObject({
    ...productionArtifactPromotionFields,
    recordFingerprint: z.string().regex(/^artifact-promotion:v1:sha256:[0-9a-f]{64}$/),
  })
  .superRefine((value, context) => {
    if (new Set(value.approvalIds).size !== value.approvalIds.length) {
      context.addIssue({ code: "custom", path: ["approvalIds"], message: "approvalIds must be unique" });
    }
    const sortedApprovalIds = [...value.approvalIds].sort();
    if (sortedApprovalIds.some((approvalId, index) => approvalId !== value.approvalIds[index])) {
      context.addIssue({ code: "custom", path: ["approvalIds"], message: "approvalIds must use canonical order" });
    }
    const { recordFingerprint: _recordFingerprint, ...input } = value;
    if (value.recordFingerprint !== getProductionArtifactPromotionFingerprint(input)) {
      context.addIssue({
        code: "custom",
        path: ["recordFingerprint"],
        message: "recordFingerprint does not match the immutable promotion record",
      });
    }
  })
  .readonly()
  .transform(deepFreeze);

/** The category of entity an approval fingerprint binds to. */
export const productionApprovalFingerprintKindSchema = z.enum(["project", "creative", "artifact", "package", "schema"]);

const plainSha256FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** A kind-tagged content-hash fingerprint that an approval binds to; one per kind. */
export const productionApprovalFingerprintSchema = z.discriminatedUnion("kind", [
  strictKind("project", { value: z.string().regex(/^director-project-revision:v1:sha256:[0-9a-f]{64}$/) }),
  strictKind("creative", { value: plainSha256FingerprintSchema }),
  strictKind("artifact", { value: z.string().regex(/^artifact-version:v1:sha256:[0-9a-f]{64}$/) }),
  strictKind("package", { value: plainSha256FingerprintSchema }),
  strictKind("schema", { value: plainSha256FingerprintSchema }),
]);

function validateUniqueFingerprintKinds(
  value: readonly ProductionApprovalFingerprint[],
  context: z.RefinementCtx,
): void {
  const kinds = value.map((fingerprint) => fingerprint.kind);
  if (new Set(kinds).size !== kinds.length) {
    context.addIssue({ code: "custom", message: "fingerprint kinds must be unique" });
  }
}

/** A set of fingerprints with unique kinds, observed at the decision target. */
export const productionApprovalFingerprintSetSchema = z
  .array(productionApprovalFingerprintSchema)
  .max(16)
  .superRefine(validateUniqueFingerprintKinds)
  .readonly();

const productionArtifactPromotionRequestFields = {
  promotionId: idSchema,
  target: productionPromotionTargetSchema,
  versionId: idSchema,
  expectedPreviousVersionId: idSchema.nullable(),
  approvalIds: z
    .array(idSchema)
    .max(64)
    .superRefine((value, context) => {
      if (new Set(value).size !== value.length)
        context.addIssue({ code: "custom", message: "approvalIds must be unique" });
    })
    .default([]),
  observedFingerprints: productionApprovalFingerprintSetSchema.default([]),
  promotedBy: idSchema,
  requireCurrentApproval: z.boolean().default(false),
} satisfies z.ZodRawShape;

/** Request shape for promoting an artifact version to a workspace slot. */
export const productionArtifactPromotionRequestSchema = z.strictObject(productionArtifactPromotionRequestFields);
/** Server-side persisted form of a promotion request, including the promotion timestamp. */
export const storedProductionArtifactPromotionInputSchema = z.strictObject({
  ...productionArtifactPromotionRequestFields,
  promotedAt: isoDateSchema,
});

/** What an approval decision covers: a shot, artifact version, edit range, or delivery. */
export const productionApprovalScopeSchema = z.discriminatedUnion("kind", [
  strictKind("shot", { shotId: idSchema }),
  strictKind("artifact-version", { versionId: idSchema }),
  strictKind("edit-range", {
    sequenceId: idSchema,
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().positive(),
  }).refine((value) => value.endUs > value.startUs, {
    message: "endUs must be greater than startUs",
    path: ["endUs"],
  }),
  strictKind("delivery", { deliveryId: idSchema }),
]);

const productionApprovalFields = {
  contract: z.literal(PRODUCTION_APPROVAL_CONTRACT),
  approvalId: idSchema,
  scope: productionApprovalScopeSchema,
  decision: z.enum(["approved", "rejected"]),
  fingerprints: z.array(productionApprovalFingerprintSchema).min(1).max(16).superRefine(validateUniqueFingerprintKinds),
  reviewerId: idSchema,
  reviewerName: nameSchema.optional(),
  checklist: z
    .array(
      z.strictObject({
        id: idSchema,
        passed: z.boolean(),
        note: z.string().trim().max(2_000).optional(),
      }),
    )
    .max(100)
    .default([]),
  note: z.string().trim().max(8_000).optional(),
  decidedAt: isoDateSchema,
  supersedesApprovalId: idSchema.optional(),
} satisfies z.ZodRawShape;

function validateProductionApproval(
  value: z.output<z.ZodObject<typeof productionApprovalFields>>,
  context: z.RefinementCtx,
): void {
  const fingerprintKinds = value.fingerprints.map((fingerprint) => fingerprint.kind);
  const sortedFingerprintKinds = [...fingerprintKinds].sort();
  if (sortedFingerprintKinds.some((kind, index) => kind !== fingerprintKinds[index])) {
    context.addIssue({ code: "custom", path: ["fingerprints"], message: "fingerprints must use canonical order" });
  }
  const checklistIds = value.checklist.map((item) => item.id);
  if (new Set(checklistIds).size !== checklistIds.length) {
    context.addIssue({ code: "custom", path: ["checklist"], message: "checklist ids must be unique" });
  }
  if (value.supersedesApprovalId === value.approvalId) {
    context.addIssue({
      code: "custom",
      path: ["supersedesApprovalId"],
      message: "an approval cannot supersede itself",
    });
  }
}

/** Input shape for creating an approval — no recordFingerprint, validated by the caller. */
export const productionApprovalInputSchema = z
  .strictObject(productionApprovalFields)
  .superRefine((value, context) => {
    const checklistIds = value.checklist.map((item) => item.id);
    if (new Set(checklistIds).size !== checklistIds.length) {
      context.addIssue({ code: "custom", path: ["checklist"], message: "checklist ids must be unique" });
    }
    if (value.supersedesApprovalId === value.approvalId) {
      context.addIssue({
        code: "custom",
        path: ["supersedesApprovalId"],
        message: "an approval cannot supersede itself",
      });
    }
  })
  .readonly();

/** Immutable approval record with a self-validating content-hash fingerprint. */
export const productionApprovalSchema = z
  .strictObject({
    ...productionApprovalFields,
    recordFingerprint: z.string().regex(/^production-approval:v1:sha256:[0-9a-f]{64}$/),
  })
  .superRefine((value, context) => {
    validateProductionApproval(value, context);
    const { recordFingerprint: _recordFingerprint, ...input } = value;
    if (value.recordFingerprint !== getProductionApprovalFingerprint(input)) {
      context.addIssue({
        code: "custom",
        path: ["recordFingerprint"],
        message: "recordFingerprint does not match the immutable approval record",
      });
    }
  })
  .readonly()
  .transform(deepFreeze);

/** Agent/MCP semantic surface for immutable evidence and guarded promotion. */
export const productionEvidenceRequestSchema = z.discriminatedUnion("op", [
  strictOperation("capabilities", {}),
  strictOperation("list_versions", { artifact_id: idSchema.optional() }),
  strictOperation("get_version", { version_id: idSchema }),
  strictOperation("put_version", { version: productionArtifactVersionInputSchema }),
  strictOperation("put_approval", { approval: productionApprovalInputSchema }),
  strictOperation("promote", {
    promotion_id: idSchema,
    target: productionPromotionTargetSchema,
    version_id: idSchema,
    expected_previous_version_id: idSchema.nullable(),
    approval_ids: z
      .array(idSchema)
      .max(64)
      .superRefine((value, context) => {
        if (new Set(value).size !== value.length) {
          context.addIssue({ code: "custom", message: "approval_ids must be unique" });
        }
      })
      .default([]),
    observed_fingerprints: productionApprovalFingerprintSetSchema.default([]),
    promoted_by: idSchema,
    require_current_approval: z.boolean().default(false),
  }),
  strictOperation("current_promotion", { target: productionPromotionTargetSchema }),
]);

/** Fully validated, deep-frozen artifact version record. */
export type ProductionArtifactVersion = z.output<typeof productionArtifactVersionSchema>;
/** Input shape for creating an artifact version. */
export type ProductionArtifactVersionInput = z.input<typeof productionArtifactVersionInputSchema>;
/** Fully validated, deep-frozen promotion record. */
export type ProductionArtifactPromotion = z.output<typeof productionArtifactPromotionSchema>;
/** Fully validated, deep-frozen approval record. */
export type ProductionApproval = z.output<typeof productionApprovalSchema>;
/** Input shape for creating an approval. */
export type ProductionApprovalInput = z.input<typeof productionApprovalInputSchema>;
/** A kind-tagged content-hash fingerprint bound by an approval. */
export type ProductionApprovalFingerprint = z.output<typeof productionApprovalFingerprintSchema>;
/** Workspace slot to which an artifact version is promoted. */
export type ProductionPromotionTarget = z.output<typeof productionPromotionTargetSchema>;
/** Server-side persisted promotion input with timestamp. */
export type StoredProductionArtifactPromotionInput = z.input<typeof storedProductionArtifactPromotionInputSchema>;
/** Agent/MCP request for evidence operations. */
export type ProductionEvidenceRequest = z.output<typeof productionEvidenceRequestSchema>;

/**
 * Computes the content-hash fingerprint for an artifact version input.
 *
 * Normalizes sourceVersionIds to canonical sorted order before hashing.
 *
 * @param input - The artifact version input to fingerprint.
 * @returns A fingerprint string in the form `artifact-version:v1:sha256:<hex>`.
 */
export function getProductionArtifactVersionFingerprint(input: ProductionArtifactVersionInput): string {
  const parsed = productionArtifactVersionInputSchema.parse(input);
  const normalized = { ...parsed, sourceVersionIds: [...parsed.sourceVersionIds].sort() };
  return `artifact-version:v1:sha256:${sha256HexSync(stableLexicalJson(normalized))}`;
}

/**
 * Computes the content-hash fingerprint for an approval input.
 *
 * Normalizes fingerprints to canonical kind-sorted order before hashing.
 *
 * @param input - The approval input to fingerprint.
 * @returns A fingerprint string in the form `production-approval:v1:sha256:<hex>`.
 */
export function getProductionApprovalFingerprint(input: ProductionApprovalInput): string {
  const parsed = productionApprovalInputSchema.parse(input);
  const normalized = {
    ...parsed,
    fingerprints: [...parsed.fingerprints].sort((left, right) => left.kind.localeCompare(right.kind)),
  };
  return `production-approval:v1:sha256:${sha256HexSync(stableLexicalJson(normalized))}`;
}

/**
 * Creates a fully validated, deep-frozen approval record from an input.
 *
 * @param input - The raw approval input, validated and normalized.
 * @returns A deep-frozen, immutable approval record with a self-validating fingerprint.
 */
export function createProductionApproval(input: ProductionApprovalInput): ProductionApproval {
  const parsed = productionApprovalInputSchema.parse(input);
  const normalized = {
    ...parsed,
    fingerprints: [...parsed.fingerprints].sort((left, right) => left.kind.localeCompare(right.kind)),
  } satisfies ProductionApprovalInput;
  return productionApprovalSchema.parse({
    ...normalized,
    recordFingerprint: getProductionApprovalFingerprint(normalized),
  });
}

/**
 * Computes the content-hash fingerprint for a promotion record (without the fingerprint field itself).
 *
 * @param input - The promotion record fields, excluding `recordFingerprint`.
 * @returns A fingerprint string in the form `artifact-promotion:v1:sha256:<hex>`.
 */
export function getProductionArtifactPromotionFingerprint(
  input: Omit<ProductionArtifactPromotion, "recordFingerprint">,
): string {
  return `artifact-promotion:v1:sha256:${sha256HexSync(stableLexicalJson(input))}`;
}

/**
 * Creates a fully validated, deep-frozen artifact version record from an input.
 *
 * Normalizes sourceVersionIds to canonical sorted order and computes the
 * self-validating recordFingerprint.
 *
 * @param input - The raw artifact version input, validated and normalized.
 * @returns A deep-frozen, immutable artifact version record.
 */
export function createProductionArtifactVersion(input: ProductionArtifactVersionInput): ProductionArtifactVersion {
  const parsed = productionArtifactVersionInputSchema.parse(input);
  const normalized = {
    ...parsed,
    sourceVersionIds: [...parsed.sourceVersionIds].sort(),
  } satisfies ProductionArtifactVersionInput;
  return productionArtifactVersionSchema.parse({
    ...normalized,
    recordFingerprint: getProductionArtifactVersionFingerprint(normalized),
  });
}

/** The result of evaluating an approval against current observed fingerprints. */
export type ProductionApprovalEvaluation =
  | { readonly current: true; readonly approval: ProductionApproval; readonly staleKinds: readonly [] }
  | { readonly current: false; readonly approval: ProductionApproval; readonly staleKinds: readonly string[] };

/**
 * Projects the effective state of an approval by comparing its immutable
 * bindings with the fingerprints observed at the decision target.
 *
 * @param approvalInput - The approval record to evaluate.
 * @param observedFingerprints - The current fingerprints observed at the target.
 * @returns An evaluation with `current: true` when all bindings match, or `current: false` with the stale kinds.
 */
export function evaluateProductionApproval(
  approvalInput: ProductionApproval,
  observedFingerprints: readonly ProductionApprovalFingerprint[],
): ProductionApprovalEvaluation {
  const approval = productionApprovalSchema.parse(approvalInput);
  const parsedObserved = productionApprovalFingerprintSetSchema.parse(observedFingerprints);
  const observed = new Map(parsedObserved.map((fingerprint) => [fingerprint.kind, fingerprint.value]));
  const staleKinds: string[] = approval.fingerprints
    .filter((fingerprint) => observed.get(fingerprint.kind) !== fingerprint.value)
    .map((fingerprint) => fingerprint.kind);
  if (approval.decision !== "approved") staleKinds.unshift("decision");
  return staleKinds.length === 0
    ? { current: true, approval, staleKinds: [] }
    : { current: false, approval, staleKinds };
}

/** Input required to create a promotion event. */
export interface CreateProductionPromotionInput {
  readonly promotionId: string;
  readonly target: ProductionPromotionTarget;
  readonly version: ProductionArtifactVersion;
  readonly previousVersionId: string | null;
  readonly approvals?: readonly ProductionApproval[];
  readonly observedFingerprints?: readonly ProductionApprovalFingerprint[];
  readonly promotedAt: string;
  readonly promotedBy: string;
  readonly requireCurrentApproval?: boolean;
}

/**
 * Exact scope matching prevents an approval for one edit target authorizing another.
 *
 * @param approvalInput - The approval record to check.
 * @param targetInput - The promotion target to match against.
 * @param versionInput - The artifact version being promoted.
 * @returns `true` when the approval's scope covers the target and version.
 */
export function productionApprovalAppliesToPromotion(
  approvalInput: ProductionApproval,
  targetInput: ProductionPromotionTarget,
  versionInput: ProductionArtifactVersion,
): boolean {
  const approval = productionApprovalSchema.parse(approvalInput);
  const target = productionPromotionTargetSchema.parse(targetInput);
  const version = productionArtifactVersionSchema.parse(versionInput);
  switch (approval.scope.kind) {
    case "artifact-version":
      return approval.scope.versionId === version.versionId;
    case "shot":
      return approval.scope.shotId === target.ownerId;
    case "edit-range":
      return target.workspace === "video" && approval.scope.sequenceId === target.ownerId;
    case "delivery":
      return target.workspace === "delivery" && approval.scope.deliveryId === target.ownerId;
  }
}

/**
 * Creates an append-only promotion event; the artifact version itself is never changed.
 *
 * Validates that all approvals are approved, apply to the promotion target,
 * and are bound to the promoted artifact version. When `requireCurrentApproval`
 * is set, at least one approval must be current against the observed fingerprints.
 *
 * @param input - The promotion creation input.
 * @returns A deep-frozen, immutable promotion record.
 * @throws When an approval is not approved, does not apply to the target, or is not bound to the artifact version.
 */
export function createProductionArtifactPromotion(input: CreateProductionPromotionInput): ProductionArtifactPromotion {
  const version = productionArtifactVersionSchema.parse(input.version);
  const target = productionPromotionTargetSchema.parse(input.target);
  const approvals = (input.approvals ?? []).map((approval) => productionApprovalSchema.parse(approval));
  const observed = productionApprovalFingerprintSetSchema.parse(input.observedFingerprints ?? []);
  for (const approval of approvals) {
    if (approval.decision !== "approved") {
      throw new Error(`Approval "${approval.approvalId}" is not an approved decision.`);
    }
    if (!productionApprovalAppliesToPromotion(approval, target, version)) {
      throw new Error(`Approval "${approval.approvalId}" does not apply to this promotion target.`);
    }
    const artifactBinding = approval.fingerprints.find((fingerprint) => fingerprint.kind === "artifact");
    if (artifactBinding?.value !== version.recordFingerprint) {
      throw new Error(`Approval "${approval.approvalId}" is not bound to the promoted artifact version.`);
    }
  }
  if (input.requireCurrentApproval) {
    if (approvals.length === 0) throw new Error("A current approval is required for this promotion.");
    const observedArtifact = observed.find((fingerprint) => fingerprint.kind === "artifact");
    if (observedArtifact?.value !== version.recordFingerprint) {
      throw new Error(
        "No approval matches the current production fingerprints: observed artifact fingerprint does not match the promoted artifact version.",
      );
    }
    const current = approvals.some((approval) => evaluateProductionApproval(approval, observed).current);
    if (!current) throw new Error("No approval matches the current production fingerprints.");
  }
  const promotion = {
    contract: PRODUCTION_ARTIFACT_PROMOTION_CONTRACT,
    promotionId: input.promotionId,
    target,
    artifactId: version.artifactId,
    versionId: version.versionId,
    artifactFingerprint: version.recordFingerprint,
    previousVersionId: input.previousVersionId,
    approvalIds: approvals.map((approval) => productionApprovalSchema.parse(approval).approvalId).sort(),
    promotedAt: input.promotedAt,
    promotedBy: input.promotedBy,
  } satisfies Omit<ProductionArtifactPromotion, "recordFingerprint">;
  return productionArtifactPromotionSchema.parse({
    ...promotion,
    recordFingerprint: getProductionArtifactPromotionFingerprint(promotion),
  });
}

/**
 * Produces a stable, encodable key for a promotion target, suitable for use as a map key.
 *
 * @param target - The promotion target to encode.
 * @returns A string in the form `workspace:ownerId:slot`.
 */
export function productionPromotionTargetKey(target: ProductionPromotionTarget): string {
  const parsed = productionPromotionTargetSchema.parse(target);
  return `${parsed.workspace}:${encodeURIComponent(parsed.ownerId)}:${encodeURIComponent(parsed.slot)}`;
}
