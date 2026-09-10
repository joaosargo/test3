import { createApp } from './app.js';
import { AuthService } from './services/auth-service.js';
import { OpenIdClientAdapter } from './adapters/openid-client-adapter.js';
import { InMemorySessionStore } from './adapters/in-memory-session-store.js';
import { JoseTokenSigner } from './adapters/jose-token-signer.js';
import { DEFAULT_COOKIE_OPTIONS } from './config/session-policy.js';

/**
 * Production entry point. Reads configuration and SECRETS from the environment
 * (ADR-AUTH-04: managed secret manager injects these at runtime; never
 * hard-coded, never in source). Fails fast if required config is absent.
 */
async function main(): Promise<void> {
  const {
    OIDC_ISSUER_URL,
    OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URI,
    SESSION_SIGNING_KEY,
    PORT,
  } = process.env;

  const required = {
    OIDC_ISSUER_URL,
    OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URI,
    SESSION_SIGNING_KEY,
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  const oidc = await OpenIdClientAdapter.create({
    issuerUrl: OIDC_ISSUER_URL as string,
    clientId: OIDC_CLIENT_ID as string,
    clientSecret: OIDC_CLIENT_SECRET as string,
    redirectUri: OIDC_REDIRECT_URI as string,
  });

  const store = new InMemorySessionStore();
  const signer = new JoseTokenSigner({
    signingKey: new TextEncoder().encode(SESSION_SIGNING_KEY as string),
  });

  const service = new AuthService({ oidc, store, signer });
  const app = createApp({ service, cookieOptions: DEFAULT_COOKIE_OPTIONS });

  const port = Number(PORT ?? 3000);
  app.listen(port, () => {
    // Operational log line — no PII, no secrets.
    console.info(`unit-platform-auth listening on port ${port}`);
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start auth service:', error instanceof Error ? error.message : error);
  process.exit(1);
});
