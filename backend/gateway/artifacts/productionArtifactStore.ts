import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  createProductionArtifactPromotion,
  createProductionArtifactVersion,
  createProductionApproval,
  productionApprovalSchema,
  productionArtifactPromotionSchema,
  productionArtifactVersionSchema,
  productionPromotionTargetKey,
  type ProductionApproval,
  type ProductionApprovalInput,
  type ProductionArtifactPromotion,
  type ProductionArtifactVersion,
  type ProductionArtifactVersionInput,
  type ProductionPromotionTarget,
  type StoredProductionArtifactPromotionInput,
} from "../../../packages/protocol/src/productionArtifactProtocol";
import { writeJsonAtomic } from "../atomicJsonFile";

const promotionPointerSchema = z.strictObject({
  contract: z.literal("director-artifact-promotion-pointer-v1"),
  targetKey: z.string().min(1).max(1_024),
  promotionId: z.string().trim().min(1).max(240),
  versionId: z.string().trim().min(1).max(240),
  promotionFingerprint: z.string().regex(/^artifact-promotion:v1:sha256:[0-9a-f]{64}$/),
  updatedAt: z.string().datetime({ offset: true }),
});
type PromotionPointer = Readonly<z.infer<typeof promotionPointerSchema>>;

/** Readable filename: sanitized id plus a short hash so distinct ids can never collide. */
function safeRecordName(id: string): string {
  const readable = id
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96)
    .replace(/[-.]+$/, "");
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return readable ? `${readable}-${hash}` : hash;
}

/** Records written before readable names existed use the full sha256 of the id. */
function legacyRecordName(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function instantMilliseconds(value: string): number {
  return new Date(value).getTime();
}

/**
 * Thrown when an idempotent write collides with previously stored evidence
 * that differs from the current input, or when a concurrent mutation has
 * changed the expected state (e.g. a promotion target's previous version).
 */
export class ProductionArtifactConflictError extends Error {
  /** Machine-readable error discriminator for client-side handling. */
  readonly code = "artifact_conflict";

  constructor(message: string) {
    super(message);
    this.name = "ProductionArtifactConflictError";
  }
}

/**
 * Thrown when the on-disk evidence violates internal structural invariants —
 * duplicate ids with different fingerprints, inconsistent artifact-to-ordinal
 * mappings, or approval supersession chains that do not resolve.
 */
export class ProductionArtifactIntegrityError extends Error {
  /** Machine-readable error discriminator for client-side handling. */
  readonly code = "artifact_integrity_error";

  constructor(message: string) {
    super(message);
    this.name = "ProductionArtifactIntegrityError";
  }
}

/**
 * Thrown when input data fails business-rule validation before any write
 * occurs — missing referenced entities, out-of-order supersession timestamps,
 * or scope mismatches.
 */
export class ProductionArtifactValidationError extends Error {
  /** Machine-readable error discriminator for client-side handling. */
  readonly code = "artifact_validation_error";

  constructor(message: string) {
    super(message);
    this.name = "ProductionArtifactValidationError";
  }
}

function createValidatedPromotion(
  input: Parameters<typeof createProductionArtifactPromotion>[0],
): ProductionArtifactPromotion {
  try {
    return createProductionArtifactPromotion(input);
  } catch (error) {
    throw new ProductionArtifactValidationError(error instanceof Error ? error.message : String(error));
  }
}

/** Input payload for promoting a stored artifact version to a production target slot. */
export type PromoteStoredArtifactInput = StoredProductionArtifactPromotionInput;

/**
 * Filesystem-backed immutable production evidence. IDs are sanitized (readable
 * prefix plus short hash) before they become filenames, so external semantic
 * IDs can never escape the approved root.
 */
export class ProductionArtifactStore {
  private readonly versionsById = new Map<string, ProductionArtifactVersion>();
  private readonly versionIdByArtifactOrdinal = new Map<string, string>();
  private readonly approvalsById = new Map<string, ProductionApproval>();
  private readonly supersededApprovalIds = new Set<string>();
  private readonly promotionsById = new Map<string, ProductionArtifactPromotion>();
  private readonly currentPromotionByTarget = new Map<string, ProductionArtifactPromotion>();
  private loadPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  /**
   * @param dataDirectory - Filesystem root under which all production-artifact
   *   evidence is stored. The store creates a `production-artifacts` subdirectory
   *   there; the caller must ensure the parent directory exists.
   */
  constructor(readonly dataDirectory: string) {}

  private root(...parts: string[]): string {
    return join(this.dataDirectory, "production-artifacts", ...parts);
  }

  private recordPath(category: "versions" | "approvals" | "promotions" | "pointers", id: string): string {
    return this.root(category, `${safeRecordName(id)}.json`);
  }

  private async loadCategory<T>(
    category: "versions" | "approvals" | "promotions" | "pointers",
    parse: (value: unknown) => T,
    recordId: (value: T) => string,
  ): Promise<T[]> {
    const directory = this.root(category);
    const values: T[] = [];
    for (const name of (await readDirectoryNames(directory)).sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const value = parse(JSON.parse(await readFile(join(directory, name), "utf8")));
        const id = recordId(value);
        if (name !== `${safeRecordName(id)}.json` && name !== `${legacyRecordName(id)}.json`) {
          throw new Error("record filename does not match its immutable semantic id");
        }
        values.push(value);
      } catch (error) {
        console.warn(`Skipping invalid ${category} evidence file "${name}": ${errorMessage(error)}`);
      }
    }
    return values;
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private indexVersion(version: ProductionArtifactVersion): void {
    const existing = this.versionsById.get(version.versionId);
    if (existing && existing.recordFingerprint !== version.recordFingerprint) {
      throw new ProductionArtifactIntegrityError(`Duplicate artifact version id "${version.versionId}".`);
    }
    const ordinalKey = `${version.artifactId}:${version.ordinal}`;
    const existingOrdinal = this.versionIdByArtifactOrdinal.get(ordinalKey);
    if (existingOrdinal && existingOrdinal !== version.versionId) {
      throw new ProductionArtifactIntegrityError(
        `Artifact "${version.artifactId}" ordinal ${version.ordinal} has multiple version ids.`,
      );
    }
    this.versionsById.set(version.versionId, version);
    this.versionIdByArtifactOrdinal.set(ordinalKey, version.versionId);
  }

  private indexApproval(approval: ProductionApproval): void {
    if (this.approvalsById.has(approval.approvalId)) {
      throw new ProductionArtifactIntegrityError(`Duplicate approval id "${approval.approvalId}".`);
    }
    this.approvalsById.set(approval.approvalId, approval);
  }

  private validateApprovalSupersession(approval: ProductionApproval): void {
    if (!approval.supersedesApprovalId) return;
    const superseded = this.approvalsById.get(approval.supersedesApprovalId);
    if (!superseded) {
      throw new ProductionArtifactIntegrityError(
        `Approval "${approval.approvalId}" supersedes missing approval "${approval.supersedesApprovalId}".`,
      );
    }
    if (JSON.stringify(superseded.scope) !== JSON.stringify(approval.scope)) {
      throw new ProductionArtifactIntegrityError(
        `Approval "${approval.approvalId}" must preserve the superseded approval scope.`,
      );
    }
    if (instantMilliseconds(approval.decidedAt) <= instantMilliseconds(superseded.decidedAt)) {
      throw new ProductionArtifactIntegrityError(
        `Approval "${approval.approvalId}" must be decided after the approval it supersedes.`,
      );
    }
    if (this.supersededApprovalIds.has(superseded.approvalId)) {
      throw new ProductionArtifactIntegrityError(`Approval "${superseded.approvalId}" is already superseded.`);
    }
    this.supersededApprovalIds.add(superseded.approvalId);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadEvidence().catch((error: unknown) => {
        // A transient load failure must not poison the store for the process lifetime.
        this.loadPromise = null;
        throw error;
      });
    }
    return this.loadPromise;
  }

  private async loadEvidence(): Promise<void> {
    this.versionsById.clear();
    this.versionIdByArtifactOrdinal.clear();
    this.approvalsById.clear();
    this.supersededApprovalIds.clear();
    this.promotionsById.clear();
    this.currentPromotionByTarget.clear();

    const versions = await this.loadCategory(
      "versions",
      (value) => productionArtifactVersionSchema.parse(value),
      (version) => version.versionId,
    );
    for (const version of versions) {
      try {
        this.indexVersion(version);
      } catch (error) {
        console.warn(`Skipping artifact version "${version.versionId}": ${errorMessage(error)}`);
      }
    }
    for (const version of versions) {
      for (const sourceVersionId of version.sourceVersionIds) {
        if (!this.versionsById.has(sourceVersionId)) {
          console.warn(`Artifact version "${version.versionId}" references missing source "${sourceVersionId}".`);
        }
      }
    }

    const approvals = await this.loadCategory(
      "approvals",
      (value) => productionApprovalSchema.parse(value),
      (approval) => approval.approvalId,
    );
    for (const approval of approvals) {
      try {
        this.indexApproval(approval);
      } catch (error) {
        console.warn(`Skipping approval "${approval.approvalId}": ${errorMessage(error)}`);
      }
    }
    approvals
      .filter((approval) => approval.supersedesApprovalId)
      .sort(
        (left, right) =>
          left.decidedAt.localeCompare(right.decidedAt) || left.approvalId.localeCompare(right.approvalId),
      )
      .forEach((approval) => {
        try {
          this.validateApprovalSupersession(approval);
        } catch (error) {
          console.warn(`Ignoring inconsistent approval supersession "${approval.approvalId}": ${errorMessage(error)}`);
        }
      });

    const promotions = await this.loadCategory(
      "promotions",
      (value) => productionArtifactPromotionSchema.parse(value),
      (promotion) => promotion.promotionId,
    );
    const indexedPromotions: ProductionArtifactPromotion[] = [];
    for (const promotion of promotions) {
      const existing = this.promotionsById.get(promotion.promotionId);
      if (existing) {
        if (existing.recordFingerprint !== promotion.recordFingerprint) {
          console.warn(`Skipping duplicate promotion id "${promotion.promotionId}" with conflicting evidence.`);
        }
        continue;
      }
      const version = this.versionsById.get(promotion.versionId);
      if (
        !version ||
        version.artifactId !== promotion.artifactId ||
        version.recordFingerprint !== promotion.artifactFingerprint
      ) {
        console.warn(
          `Skipping promotion "${promotion.promotionId}": it does not reference matching immutable artifact evidence.`,
        );
        continue;
      }
      if (promotion.approvalIds.some((approvalId) => !this.approvalsById.has(approvalId))) {
        console.warn(`Skipping promotion "${promotion.promotionId}": it references missing approval evidence.`);
        continue;
      }
      this.promotionsById.set(promotion.promotionId, promotion);
      indexedPromotions.push(promotion);
    }

    const pointers = await this.loadCategory(
      "pointers",
      (value) => promotionPointerSchema.parse(value),
      (pointer) => pointer.targetKey,
    );
    const pointerTargets = new Set<string>();
    for (const pointer of pointers) {
      const promotion = this.promotionsById.get(pointer.promotionId);
      if (
        !promotion ||
        pointer.targetKey !== productionPromotionTargetKey(promotion.target) ||
        pointer.versionId !== promotion.versionId ||
        pointer.promotionFingerprint !== promotion.recordFingerprint ||
        pointer.updatedAt !== promotion.promotedAt
      ) {
        console.warn(
          `Skipping promotion pointer "${pointer.targetKey}": it does not reference matching promotion evidence.`,
        );
        continue;
      }
      // Readable and legacy pointer files can coexist for one target; keep the newest promotion.
      const current = pointerTargets.has(pointer.targetKey)
        ? this.currentPromotionByTarget.get(pointer.targetKey)
        : undefined;
      if (
        current &&
        (instantMilliseconds(current.promotedAt) > instantMilliseconds(promotion.promotedAt) ||
          (instantMilliseconds(current.promotedAt) === instantMilliseconds(promotion.promotedAt) &&
            current.promotionId >= promotion.promotionId))
      ) {
        continue;
      }
      pointerTargets.add(pointer.targetKey);
      this.currentPromotionByTarget.set(pointer.targetKey, promotion);
    }

    // Backward-compatible recovery for records written before pointer files existed.
    for (const promotion of indexedPromotions) {
      const targetKey = productionPromotionTargetKey(promotion.target);
      if (pointerTargets.has(targetKey)) continue;
      const current = this.currentPromotionByTarget.get(targetKey);
      if (
        !current ||
        instantMilliseconds(promotion.promotedAt) > instantMilliseconds(current.promotedAt) ||
        (instantMilliseconds(promotion.promotedAt) === instantMilliseconds(current.promotedAt) &&
          promotion.promotionId > current.promotionId)
      ) {
        this.currentPromotionByTarget.set(targetKey, promotion);
      }
    }
  }

  /**
   * Persist an artifact version record. The operation is idempotent: replaying
   * the same input returns the existing record with `replayed: true`.
   *
   * @param input - The version to store; must include artifact id, ordinal,
   *   fingerprint-eligible fields, and optional source version references.
   * @returns The stored version together with a `replayed` flag indicating
   *   whether this call was an idempotent replay of already-written evidence.
   * @throws {@link ProductionArtifactConflictError} When the same version id or
   *   artifact ordinal already has different evidence.
   * @throws {@link ProductionArtifactValidationError} When a referenced source
   *   version does not exist in the store.
   */
  async putVersion(
    input: ProductionArtifactVersionInput,
  ): Promise<{ version: ProductionArtifactVersion; replayed: boolean }> {
    return this.runSerialized(() => this.putVersionSerialized(input));
  }

  private async putVersionSerialized(
    input: ProductionArtifactVersionInput,
  ): Promise<{ version: ProductionArtifactVersion; replayed: boolean }> {
    await this.ensureLoaded();
    const version = createProductionArtifactVersion(input);
    const existing = this.versionsById.get(version.versionId);
    if (existing) {
      if (existing.recordFingerprint !== version.recordFingerprint) {
        throw new ProductionArtifactConflictError(
          `Artifact version id "${version.versionId}" already has different evidence.`,
        );
      }
      return { version: existing, replayed: true };
    }
    const ordinalKey = `${version.artifactId}:${version.ordinal}`;
    const existingOrdinal = this.versionIdByArtifactOrdinal.get(ordinalKey);
    if (existingOrdinal) {
      throw new ProductionArtifactConflictError(
        `Artifact "${version.artifactId}" ordinal ${version.ordinal} is already assigned to "${existingOrdinal}".`,
      );
    }
    for (const sourceVersionId of version.sourceVersionIds) {
      if (!this.versionsById.has(sourceVersionId)) {
        throw new ProductionArtifactValidationError(`Source artifact version "${sourceVersionId}" does not exist.`);
      }
    }
    await writeJsonAtomic(this.recordPath("versions", version.versionId), version, { trailingNewline: true });
    this.indexVersion(version);
    return { version, replayed: false };
  }

  /**
   * Return the stored artifact version for the given id, or `null` when none
   * exists. Reads wait for in-flight mutations to settle so the returned
   * value is always consistent with the latest write.
   *
   * @param versionId - The immutable version id assigned by the protocol layer.
   * @returns The matching version record, or `null` if not found.
   */
  async getVersion(versionId: string): Promise<ProductionArtifactVersion | null> {
    await this.ensureLoaded();
    await this.mutationTail;
    return this.versionsById.get(versionId) ?? null;
  }

  /**
   * List every stored artifact version, optionally narrowed to a single
   * artifact. Results are sorted by artifact id then ordinal.
   *
   * @param artifactId - When provided, only versions belonging to this artifact
   *   are returned; otherwise all versions across all artifacts are listed.
   * @returns A frozen array of versions, sorted by (artifactId, ordinal).
   */
  async listVersions(artifactId?: string): Promise<readonly ProductionArtifactVersion[]> {
    await this.ensureLoaded();
    await this.mutationTail;
    return [...this.versionsById.values()]
      .filter((version) => artifactId === undefined || version.artifactId === artifactId)
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.ordinal - right.ordinal);
  }

  /**
   * Persist an approval record. The operation is idempotent: replaying the
   * same input returns the existing record with `replayed: true`.
   *
   * @param input - The approval to store; must include a scope, a decision
   *   timestamp, and an optional superseded-approval reference.
   * @returns The stored approval together with a `replayed` flag.
   * @throws {@link ProductionArtifactConflictError} When the same approval id
   *   already exists with different evidence, or when the approval it
   *   supersedes has already been superseded by another record.
   * @throws {@link ProductionArtifactValidationError} When the superseded
   *   approval does not exist, has a different scope, or has a later timestamp.
   */
  async putApproval(input: ProductionApprovalInput): Promise<{ approval: ProductionApproval; replayed: boolean }> {
    return this.runSerialized(() => this.putApprovalSerialized(input));
  }

  private async putApprovalSerialized(
    input: ProductionApprovalInput,
  ): Promise<{ approval: ProductionApproval; replayed: boolean }> {
    await this.ensureLoaded();
    const approval = createProductionApproval(input);
    const existing = this.approvalsById.get(approval.approvalId);
    if (existing) {
      if (!sameRecord(existing, approval)) {
        throw new ProductionArtifactConflictError(`Approval id "${approval.approvalId}" is immutable.`);
      }
      return { approval: existing, replayed: true };
    }
    if (approval.supersedesApprovalId) {
      const superseded = this.approvalsById.get(approval.supersedesApprovalId);
      if (!superseded) {
        throw new ProductionArtifactValidationError(
          `Superseded approval "${approval.supersedesApprovalId}" does not exist.`,
        );
      }
      if (JSON.stringify(superseded.scope) !== JSON.stringify(approval.scope)) {
        throw new ProductionArtifactValidationError(
          "A superseding approval must preserve the original approval scope.",
        );
      }
      if (instantMilliseconds(approval.decidedAt) <= instantMilliseconds(superseded.decidedAt)) {
        throw new ProductionArtifactValidationError(
          "A superseding approval must be decided after the original approval.",
        );
      }
      if (this.supersededApprovalIds.has(superseded.approvalId)) {
        throw new ProductionArtifactConflictError(`Approval "${superseded.approvalId}" is already superseded.`);
      }
    }
    await writeJsonAtomic(this.recordPath("approvals", approval.approvalId), approval, { trailingNewline: true });
    this.indexApproval(approval);
    this.validateApprovalSupersession(approval);
    return { approval, replayed: false };
  }

  /**
   * Return the stored approval for the given id, or `null` when none exists.
   * Reads wait for in-flight mutations to settle.
   *
   * @param approvalId - The immutable approval id assigned by the protocol layer.
   * @returns The matching approval record, or `null` if not found.
   */
  async getApproval(approvalId: string): Promise<ProductionApproval | null> {
    await this.ensureLoaded();
    await this.mutationTail;
    return this.approvalsById.get(approvalId) ?? null;
  }

  /**
   * Return the currently active promotion for a given target slot, or `null`
   * when no version has been promoted there. Reads wait for in-flight
   * mutations to settle.
   *
   * @param target - The production target slot (workspace, owner, slot).
   * @returns The active promotion record, or `null` if the slot is empty.
   */
  async getCurrentPromotion(target: ProductionPromotionTarget): Promise<ProductionArtifactPromotion | null> {
    await this.ensureLoaded();
    await this.mutationTail;
    return this.currentPromotionByTarget.get(productionPromotionTargetKey(target)) ?? null;
  }

  /**
   * Promote a stored artifact version to a production target slot. The
   * operation is idempotent and uses an optimistic-concurrency check via
   * `expectedPreviousVersionId` to prevent accidental overwrites. On replay
   * it also repairs a rare crash window where the immutable promotion event
   * was persisted but the mutable pointer file was not.
   *
   * @param input - The promotion request: target, version, approval ids,
   *   and the expected previous version id for the slot.
   * @returns The persisted promotion together with a `replayed` flag.
   * @throws {@link ProductionArtifactConflictError} When the same promotion id
   *   already exists with a different request, or when the expected previous
   *   version id does not match the slot's current version.
   * @throws {@link ProductionArtifactValidationError} When the artifact
   *   version, an approval, or the protocol-level promotion construction fails.
   */
  async promote(
    input: PromoteStoredArtifactInput,
  ): Promise<{ promotion: ProductionArtifactPromotion; replayed: boolean }> {
    return this.runSerialized(() => this.promoteSerialized(input));
  }

  private async promoteSerialized(
    input: PromoteStoredArtifactInput,
  ): Promise<{ promotion: ProductionArtifactPromotion; replayed: boolean }> {
    await this.ensureLoaded();
    const version = this.versionsById.get(input.versionId);
    if (!version) {
      throw new ProductionArtifactValidationError(`Artifact version "${input.versionId}" does not exist.`);
    }
    const targetKey = productionPromotionTargetKey(input.target);
    const approvals = (input.approvalIds ?? []).map((approvalId) => {
      const approval = this.approvalsById.get(approvalId);
      if (!approval) throw new ProductionArtifactValidationError(`Approval "${approvalId}" does not exist.`);
      return approval;
    });

    const existing = this.promotionsById.get(input.promotionId);
    if (existing) {
      const replay = createValidatedPromotion({
        ...input,
        target: input.target,
        version,
        previousVersionId: input.expectedPreviousVersionId,
        approvals,
      });
      if (
        replay.target.workspace !== existing.target.workspace ||
        replay.target.ownerId !== existing.target.ownerId ||
        replay.target.slot !== existing.target.slot ||
        replay.versionId !== existing.versionId ||
        replay.previousVersionId !== existing.previousVersionId ||
        replay.promotedBy !== existing.promotedBy ||
        !sameRecord(replay.approvalIds, existing.approvalIds)
      ) {
        throw new ProductionArtifactConflictError(
          `Promotion id "${input.promotionId}" is already bound to a different request.`,
        );
      }

      // Repair the only crash window: immutable event persisted, mutable pointer did not.
      const current = this.currentPromotionByTarget.get(targetKey) ?? null;
      if (
        current?.promotionId === existing.promotionId ||
        ((current?.versionId ?? null) === existing.previousVersionId &&
          (current === null || instantMilliseconds(current.promotedAt) < instantMilliseconds(existing.promotedAt)))
      ) {
        await this.writePromotionPointer(targetKey, existing);
        this.currentPromotionByTarget.set(targetKey, existing);
      }
      return { promotion: existing, replayed: true };
    }

    for (const approvalId of input.approvalIds ?? []) {
      if (this.supersededApprovalIds.has(approvalId)) {
        throw new ProductionArtifactValidationError(`Approval "${approvalId}" has been superseded.`);
      }
    }

    const current = this.currentPromotionByTarget.get(targetKey) ?? null;
    const actualPreviousVersionId = current?.versionId ?? null;
    if (actualPreviousVersionId !== input.expectedPreviousVersionId) {
      throw new ProductionArtifactConflictError(
        `Promotion target changed: expected ${String(input.expectedPreviousVersionId)}, current ${String(actualPreviousVersionId)}.`,
      );
    }

    const promotion = createValidatedPromotion({
      ...input,
      version,
      previousVersionId: actualPreviousVersionId,
      approvals,
    });
    await writeJsonAtomic(this.recordPath("promotions", promotion.promotionId), promotion, { trailingNewline: true });
    this.promotionsById.set(promotion.promotionId, promotion);
    await this.writePromotionPointer(targetKey, promotion);
    this.currentPromotionByTarget.set(targetKey, promotion);
    return { promotion, replayed: false };
  }

  private async writePromotionPointer(targetKey: string, promotion: ProductionArtifactPromotion): Promise<void> {
    const pointer: PromotionPointer = {
      contract: "director-artifact-promotion-pointer-v1",
      targetKey,
      promotionId: promotion.promotionId,
      versionId: promotion.versionId,
      promotionFingerprint: promotion.recordFingerprint,
      updatedAt: promotion.promotedAt,
    };
    await writeJsonAtomic(this.recordPath("pointers", targetKey), pointer, { trailingNewline: true });
    // Pointers are mutable; retire the pre-readable-name file so it cannot shadow this update.
    const legacyPath = this.root("pointers", `${legacyRecordName(targetKey)}.json`);
    if (legacyPath !== this.recordPath("pointers", targetKey)) {
      await rm(legacyPath, { force: true }).catch(() => undefined);
    }
  }
}
