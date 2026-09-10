import { describe, it, expect } from 'vitest';
import { JoseTokenSigner } from './jose-token-signer.js';

const KEY = new TextEncoder().encode('a-test-signing-key-of-at-least-32-bytes!!');

describe('JoseTokenSigner', () => {
  it('signs and verifies a round-trip token (happy path)', async () => {
    const signer = new JoseTokenSigner({ signingKey: KEY });
    const now = Math.floor(Date.now() / 1000);
    const claims = { sid: 's1', sub: 'u1', iat: now, exp: now + 3600, lsa: now };
    const token = await signer.sign(claims);
    const decoded = await signer.verify(token);
    expect(decoded.sid).toBe('s1');
    expect(decoded.sub).toBe('u1');
  });

  it('rejects a signing key shorter than 256 bits', () => {
    expect(() => new JoseTokenSigner({ signingKey: new Uint8Array(16) })).toThrow();
  });

  it('rejects a token signed with a different key (tamper/forgery)', async () => {
    const signer = new JoseTokenSigner({ signingKey: KEY });
    const otherKey = new TextEncoder().encode('a-DIFFERENT-signing-key-of-32-plus-bytes!');
    const other = new JoseTokenSigner({ signingKey: otherKey });
    const now = Math.floor(Date.now() / 1000);
    const token = await other.sign({ sid: 's1', sub: 'u1', iat: now, exp: now + 3600, lsa: now });
    await expect(signer.verify(token)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const signer = new JoseTokenSigner({ signingKey: KEY });
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await signer.sign({ sid: 's1', sub: 'u1', iat: past, exp: past + 60, lsa: past });
    await expect(signer.verify(token)).rejects.toThrow();
  });
});
