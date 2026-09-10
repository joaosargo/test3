/**
 * Workflow error taxonomy for unit-request-workflow.
 *
 * Grounded in domain-entities (`WorkflowError` value object) and business-rules
 * (`BR-INV-6` PII-free codes; deny-by-default). Expected business failures are
 * returned as `Result.err` values carrying a machine-readable, PII-free code —
 * never thrown. Throwing is reserved for programmer error / misconfiguration,
 * mirroring the shipped `SsoError` / `AuthzError` / `HrisError` taxonomy.
 *
 * PII rule (`req-nfr-security-pii`, `BR-INV-6`): codes and messages MUST NOT
 * contain the subject principal id, department, or free-text reason.
 */

/** Machine-readable workflow failure codes (business-rules Validation & Edge Cases). */
export type WorkflowErrorCode =
  | 'INVALID_INPUT' // BR-VAL-1..4: malformed / out-of-range submit payload
  | 'NOT_FOUND' // command targets an unknown request id
  | 'FORBIDDEN' // authorization deny (echoes the authz reason)
  | 'ILLEGAL_TRANSITION' // BR-WF-2/6: state precondition not met
  | 'STALE_STATE'; // BR-INV-3: optimistic-concurrency version mismatch

/**
 * Typed workflow error. Carries a machine-readable code, a PII-free message,
 * and optional `field` (for `INVALID_INPUT`) / `cause` (for `FORBIDDEN`,
 * echoing the authz `AuthzDenyReason`). Returned inside `Result<T,
 * WorkflowError>`; mirrors `SsoError` / `AuthzError` for a consistent boundary
 * error shape across the monolith.
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  /** Offending field name for `INVALID_INPUT`. */
  readonly field?: string;
  /** Underlying deny reason for `FORBIDDEN` (an authz `AuthzDenyReason`). */
  readonly cause?: string;

  constructor(code: WorkflowErrorCode, message: string, opts: { field?: string; cause?: string } = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    if (opts.field !== undefined) this.field = opts.field;
    if (opts.cause !== undefined) this.cause = opts.cause;
    Object.setPrototypeOf(this, WorkflowError.prototype);
  }

  static invalidInput(field: string): WorkflowError {
    return new WorkflowError('INVALID_INPUT', 'One or more fields are invalid.', { field });
  }

  static notFound(): WorkflowError {
    return new WorkflowError('NOT_FOUND', 'The requested resource was not found.');
  }

  static forbidden(cause?: string): WorkflowError {
    return new WorkflowError('FORBIDDEN', 'You do not have permission to perform this action.', {
      cause,
    });
  }

  static illegalTransition(): WorkflowError {
    return new WorkflowError('ILLEGAL_TRANSITION', 'This action is not allowed in the current state.');
  }

  static staleState(): WorkflowError {
    return new WorkflowError('STALE_STATE', 'This request changed since it was last read; re-read and retry.');
  }
}
