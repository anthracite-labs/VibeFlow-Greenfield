/**
 * M-014 private content-addressed archive staging port.
 *
 * SCOPE WARNING: this is the smallest possible infrastructure port needed to
 * keep archive bytes OUT of canonical Project/Artifact metadata rows. It is
 * deliberately NOT:
 * - a canonical `ObjectStorageBinding` (that resource belongs to the deferred
 *   provider-binding missions, M-016+),
 * - a provider integration or credential surface,
 * - an Artifact content/version store,
 * - a public package export beyond the port type and the in-memory adapter
 *   used by tests.
 *
 * It advances no storage/provider capability and confers no provider
 * authority. A staged reference is opaque VibeFlow-internal state: it can
 * never establish Organization/Project ownership.
 */

import { createHash } from "node:crypto";

/**
 * An opaque, content-addressed staging reference. The value is derived
 * server-side from the content digest; a caller cannot choose it.
 */
export type StagedArchiveRef = string;

export interface ArchiveStagingPort {
  /**
   * Stage archive bytes under their content address, acquire one reference
   * claim for the caller, and return the opaque reference. The content write is
   * idempotent; repeated puts of identical bytes share one blob while holding
   * independent claims.
   */
  put(bytes: Buffer): Promise<StagedArchiveRef>;
  /** Read staged bytes back, or `undefined` when the ref is unknown. */
  get(ref: StagedArchiveRef): Promise<Buffer | undefined>;
  /**
   * Release one caller claim. The bytes are deleted only when the final claim
   * is released, so a failed import cannot delete content retained by another
   * successful import of the same archive.
   */
  release(ref: StagedArchiveRef): Promise<void>;
  /** Administrative/test force-delete. Removing an unknown ref is a no-op. */
  delete(ref: StagedArchiveRef): Promise<void>;
}

/** Build the opaque content-addressed reference for some bytes. */
export function stagedArchiveRefFor(bytes: Buffer): StagedArchiveRef {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * In-memory staging adapter.
 *
 * Sufficient for tests and for a single-process control plane; a durable
 * object-store adapter is a later infrastructure concern and does NOT belong
 * to the canonical resource model.
 */
export class InMemoryArchiveStaging implements ArchiveStagingPort {
  private readonly blobs = new Map<StagedArchiveRef, Buffer>();
  private readonly claims = new Map<StagedArchiveRef, number>();

  public async put(bytes: Buffer): Promise<StagedArchiveRef> {
    const ref = stagedArchiveRefFor(bytes);
    if (!this.blobs.has(ref)) {
      this.blobs.set(ref, Buffer.from(bytes));
    }
    this.claims.set(ref, (this.claims.get(ref) ?? 0) + 1);
    return ref;
  }

  public async get(ref: StagedArchiveRef): Promise<Buffer | undefined> {
    const stored = this.blobs.get(ref);
    return stored === undefined ? undefined : Buffer.from(stored);
  }

  public async release(ref: StagedArchiveRef): Promise<void> {
    const current = this.claims.get(ref);
    if (current === undefined) {
      return;
    }
    if (current <= 1) {
      this.claims.delete(ref);
      this.blobs.delete(ref);
      return;
    }
    this.claims.set(ref, current - 1);
  }

  public async delete(ref: StagedArchiveRef): Promise<void> {
    this.claims.delete(ref);
    this.blobs.delete(ref);
  }

  /** Test/diagnostic helper: how many distinct blobs are currently staged. */
  public get size(): number {
    return this.blobs.size;
  }

  /** Test/diagnostic helper: number of retained claims for one staged blob. */
  public claimCount(ref: StagedArchiveRef): number {
    return this.claims.get(ref) ?? 0;
  }
}
