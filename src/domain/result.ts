/**
 * Result type for expected, value-level failures.
 *
 * Per business-logic-model (`return_type`), auth failures are VALUES, not
 * thrown exceptions: `completeLogin` returns `Result<AuthenticatedPrincipal,
 * SsoError>`. Throwing is reserved for programmer errors / misconfiguration.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<E, T = never>(error: E): Result<T, E> {
  return { ok: false, error };
}
