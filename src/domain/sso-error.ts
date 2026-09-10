/**
 * SSO error taxonomy for unit-platform-auth.
 *
 * Every failure branch in the ordered fail-closed validation
 * (security-design "Ordered Fail-Closed Assertion Validation") maps to one of
 * these codes. There is NO in-house credential path on any branch
 * (req-constraint-sso-mandatory) — every error is "access denied", never a
 * password prompt.
 *
 * PII rule (BR-PII-*, security-design): error messages MUST NOT contain raw
 * assertion material, tokens, emails, or any subject PII.
 */
export type SsoErrorCode =
  | 'CONFIG_ERROR' // IdP metadata/client misconfigured (SsoConfigError)
  | 'TRANSPORT_INSECURE' // check 1: callback not over TLS
  | 'STATE_MISMATCH' // check 2: state/CSRF mismatch
  | 'NONCE_REPLAY' // check 3: nonce reused / not found
  | 'SIGNATURE_INVALID' // check 4: signature verification failed
  | 'ISSUER_MISMATCH' // check 5: iss != configured issuer
  | 'AUDIENCE_MISMATCH' // check 6: aud != client id
  | 'TOKEN_EXPIRED' // check 7: exp/nbf / clock-skew violation
  | 'SUBJECT_MISSING' // check 8: no stable subject
  | 'MALFORMED_ASSERTION' // rejected before expensive processing
  | 'IDP_UNAVAILABLE' // IdP back-channel failure -> auth failure, no local fallback
  | 'SESSION_NOT_FOUND'; // session revoked/expired/unknown

/**
 * Domain error for the SSO boundary. Carries a machine-readable code and a
 * PII-free human message. `cause` is retained for server-side diagnostics only
 * and must never be serialised to a client response or a log line verbatim.
 */
export class SsoError extends Error {
  readonly code: SsoErrorCode;

  constructor(code: SsoErrorCode, message: string) {
    super(message);
    this.name = 'SsoError';
    this.code = code;
    Object.setPrototypeOf(this, SsoError.prototype);
  }

  static of(code: SsoErrorCode, message: string): SsoError {
    return new SsoError(code, message);
  }
}
