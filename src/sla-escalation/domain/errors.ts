/**
 * SLA error taxonomy for unit-sla-escalation.
 *
 * Grounded in functional-design `domain-entities` (`SlaError`) and
 * `business-rules` (`BR-SLA-8`, `BR-SLA-10 / BR-PII-4`). Expected value-level
 * failures (unresolvable escalation contact, transient channel error, workflow
 * read failure) are returned as `Result.err` values carrying a machine-readable,
 * PII-free code — never thrown. Mirrors the shipped `SsoError` / `AuthzError` /
 * `WorkflowError` / `NotificationError` taxonomy.
 *
 * Throwing is reserved for the ONE misconfiguration case — `MISCONFIGURED_POLICY`
 * at policy load (`BR-SLA-4a`, fail-closed) — surfaced via `throwMisconfigured`.
 *
 * PII rule (`req-nfr-security-pii`, `BR-PII-2` / `BR-PII-4`): codes and messages
 * MUST NOT contain a principal id, email, display name, or free-text reason.
 */

/** Machine-readable SLA failure codes (PII-free, `BR-PII-4`). */
export type SlaErrorCode =
  | 'MISCONFIGURED_POLICY' // non-monotonic / invalid thresholds at load (the one throw)
  | 'RECIPIENT_UNRESOLVED' // directory could not resolve an escalation/reminder contact
  | 'CHANNEL_ERROR' // a reused notification channel dead-lettered
  | 'WORKFLOW_READ_ERROR'; // the read-only workflow pending query failed

/**
 * Typed SLA error. Carries a machine-readable code and a PII-free message;
 * returned inside `Result<T, SlaError>` (never thrown, except the misconfig
 * factory which is thrown at load). Mirrors the shipped boundary-error shape.
 */
export class SlaError extends Error {
  readonly code: SlaErrorCode;

  constructor(code: SlaErrorCode, message: string) {
    super(message);
    this.name = 'SlaError';
    this.code = code;
    Object.setPrototypeOf(this, SlaError.prototype);
  }

  static misconfiguredPolicy(detail: string): SlaError {
    // `detail` is a PII-free structural message (e.g. a stage name), never
    // contact data — safe to surface for the fail-closed load throw.
    return new SlaError('MISCONFIGURED_POLICY', `SLA policy is misconfigured: ${detail}`);
  }

  static recipientUnresolved(): SlaError {
    return new SlaError('RECIPIENT_UNRESOLVED', 'The SLA recipient could not be resolved.');
  }

  static channelError(): SlaError {
    return new SlaError('CHANNEL_ERROR', 'An SLA notification channel failed to deliver.');
  }

  static workflowReadError(): SlaError {
    return new SlaError('WORKFLOW_READ_ERROR', 'The pending-request read failed.');
  }
}

/**
 * Throw the one allowed exception — an invalid policy at load (`BR-SLA-4a`,
 * fail-closed). Never scan with a broken policy.
 */
export function throwMisconfigured(detail: string): never {
  throw SlaError.misconfiguredPolicy(detail);
}
