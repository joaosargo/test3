import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { SessionTokenClaims, TokenSigner } from '../ports/token-signer.js';

/**
 * jose-based stateless session token signer (HS256 by default).
 *
 * The signing key is INJECTED (from a managed secret manager per ADR-AUTH-04),
 * never hard-coded or read from source. The token is tamper-evident so it
 * cannot be forged client-side (security-design SEC-SES-5). Verification is
 * in-process with no store round-trip (performance-design hot-path ADR).
 */
export class JoseTokenSigner implements TokenSigner {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(opts: { signingKey: Uint8Array; issuer?: string; audience?: string }) {
    if (opts.signingKey.length < 32) {
      throw new Error('Session signing key must be at least 256 bits.');
    }
    this.key = opts.signingKey;
    this.issuer = opts.issuer ?? 'vra-auth';
    this.audience = opts.audience ?? 'vra-app';
  }

  async sign(claims: SessionTokenClaims): Promise<string> {
    return new SignJWT({ sid: claims.sid, lsa: claims.lsa })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuedAt(claims.iat)
      .setExpirationTime(claims.exp)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .sign(this.key);
  }

  async verify(token: string): Promise<SessionTokenClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: this.issuer,
      audience: this.audience,
    });
    return toSessionClaims(payload);
  }
}

function toSessionClaims(payload: JWTPayload): SessionTokenClaims {
  const sid = payload.sid;
  const lsa = payload.lsa;
  if (
    typeof sid !== 'string' ||
    typeof payload.sub !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    typeof lsa !== 'number'
  ) {
    throw new Error('Malformed session token payload.');
  }
  return { sid, sub: payload.sub, iat: payload.iat, exp: payload.exp, lsa };
}
