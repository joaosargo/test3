/**
 * Overlap error taxonomy for unit-overlap-indicator.
 *
 * Grounded in domain-entities (`OverlapError` value object) and business-rules
 * (BR-PII-3 PII-free codes; BR-ADV-3 fail-open). Expected read failures are
 * returned as `Result.err` values carrying a machine-readable, PII-free code —
 * never thrown. Throwing is reserved for programmer error / misconfiguration,
 * mirroring the shipped `WorkflowError` / `AuthzError` / `SsoError` / `HrisError`
 * taxonomy.
 *
 * PII rule (`req-nfr-security-pii`, BR-PII-3): codes and messages MUST NOT
 * contain the subject principal id, department, or free-text reason.
 */

/** Machine-readable overlap failure codes (domain-entities `OverlapError`). */
export type OverlapErrorCode =
  | 'NOT_FOUND' // the reviewed request id resolves to nothing
  | 'READ_FAILED'; // the repository read seam errored

/**
 * Typed overlap error. Carries a machine-readable code and a PII-free message.
 * Returned inside `Result<OverlapSummary, OverlapError>`; treated by callers as
 * fail-open advisory (BR-ADV-3) — a missing/failed summary degrades the UI to
 * "overlap unavailable" and never blocks a workflow decision.
 */
export class OverlapError extends Error {
  readonly code: OverlapErrorCode;

  constructor(code: OverlapErrorCode, message: string) {
    super(message);
    this.name = 'OverlapError';
    this.code = code;
    Object.setPrototypeOf(this, OverlapError.prototype);
  }

  /** The reviewed request id resolves to nothing (BR-ADV-3). */
  static notFound(): OverlapError {
    return new OverlapError('NOT_FOUND', 'The reviewed request was not found.');
  }

  /** The repository read seam errored (BR-ADV-3). */
  static readFailed(): OverlapError {
    return new OverlapError('READ_FAILED', 'The overlap summary is currently unavailable.');
  }
}
