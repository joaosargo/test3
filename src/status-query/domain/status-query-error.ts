/**
 * `StatusQueryError` — the read side's typed, value-level failure for
 * unit-status-query.
 *
 * Grounded in domain-entities ("`StatusQueryError`") and business-rules
 * (BR-SQ-16). Returned inside `Result<T, StatusQueryError>` per the shipped
 * `result.ts` convention — NEVER thrown (throwing is reserved for
 * misconfiguration), mirroring `WorkflowError` / `AuthzError` / `SsoError`.
 *
 * PII (`req-nfr-security-pii`, BR-SQ-16): all codes are machine-readable and
 * PII-free; messages are static PII-free constants. The optional `cause` echoes
 * the upstream authz deny reason (itself a PII-free enum) on FORBIDDEN.
 */

/** Machine-readable, PII-free status-query failure codes (BR-SQ-16). */
export type StatusQueryErrorCode =
  | 'INVALID_INPUT' // bad status filter / missing department or id (BR-SQ-12..14)
  | 'FORBIDDEN' // PDP denied the read (BR-SQ-1); echoes the authz reason
  | 'NOT_FOUND'; // no such request id, not leaked to out-of-scope callers (BR-SQ-4)

/** Typed read-side error; static PII-free message. Mirrors the WorkflowError shape. */
export class StatusQueryError extends Error {
  readonly code: StatusQueryErrorCode;
  readonly field?: string;
  /** Optional upstream authz deny reason echoed on FORBIDDEN. */
  readonly cause?: string;

  private constructor(
    code: StatusQueryErrorCode,
    message: string,
    field?: string,
    cause?: string,
  ) {
    super(message);
    this.name = 'StatusQueryError';
    this.code = code;
    if (field !== undefined) this.field = field;
    if (cause !== undefined) this.cause = cause;
    Object.setPrototypeOf(this, StatusQueryError.prototype);
  }

  /** The query input was not valid (BR-SQ-12..14). */
  static invalidInput(field: string): StatusQueryError {
    return new StatusQueryError('INVALID_INPUT', 'The query input was not valid.', field);
  }

  /** The PDP denied the read (BR-SQ-1); `cause` echoes the PII-free authz reason. */
  static forbidden(cause?: string): StatusQueryError {
    return new StatusQueryError('FORBIDDEN', 'You are not permitted to view this.', undefined, cause);
  }

  /** No such request id — never confirms existence to an out-of-scope caller (BR-SQ-4). */
  static notFound(): StatusQueryError {
    return new StatusQueryError('NOT_FOUND', 'The requested resource was not found.');
  }
}
