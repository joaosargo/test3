import { Issuer, generators, type Client } from 'openid-client';
import type {
  AuthorizationRequest,
  OidcClientPort,
  ValidatedClaims,
} from '../ports/oidc-client.js';
import { deriveCodeChallenge } from '../domain/crypto.js';

export interface OidcConfig {
  /** Trusted issuer URL (OIDC discovery endpoint base). */
  readonly issuerUrl: string;
  readonly clientId: string;
  /** Client secret injected from a managed secret manager (ADR-AUTH-04). */
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scope?: string;
}

/**
 * openid-client-backed OidcClientPort — the certified-library adapter
 * (ADR-AUTH-01: never hand-roll assertion parsing or signature verification).
 * openid-client performs JWKS-cached signature verification, issuer/audience
 * checks, and nonce validation during `callback`. This adapter isolates all
 * IdP protocol shapes from the domain (Adapter/Port anti-corruption boundary).
 *
 * Discovery is done once at construction via `create`, so the JWKS/metadata
 * cache is warm and the hot path avoids synchronous network fetches
 * (performance-design caching architecture).
 */
export class OpenIdClientAdapter implements OidcClientPort {
  readonly issuer: string;
  readonly clientId: string;
  private readonly client: Client;
  private readonly redirectUri: string;
  private readonly scope: string;

  private constructor(client: Client, config: OidcConfig, issuer: string) {
    this.client = client;
    this.clientId = config.clientId;
    this.issuer = issuer;
    this.redirectUri = config.redirectUri;
    this.scope = config.scope ?? 'openid profile email';
  }

  /** Discover IdP metadata and build a configured client (call once at boot). */
  static async create(config: OidcConfig): Promise<OpenIdClientAdapter> {
    const issuer = await Issuer.discover(config.issuerUrl);
    const client = new issuer.Client({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uris: [config.redirectUri],
      response_types: ['code'],
    });
    const issuerId =
      typeof issuer.metadata.issuer === 'string' ? issuer.metadata.issuer : config.issuerUrl;
    return new OpenIdClientAdapter(client, config, issuerId);
  }

  buildAuthorizationUrl(req: AuthorizationRequest): string {
    return this.client.authorizationUrl({
      scope: this.scope,
      state: req.state,
      nonce: req.nonce,
      code_challenge: deriveCodeChallenge(req.codeVerifier),
      code_challenge_method: 'S256',
      redirect_uri: this.redirectUri,
    });
  }

  async exchangeCode(params: {
    code: string;
    codeVerifier: string;
    expectedNonce: string;
  }): Promise<ValidatedClaims> {
    const tokenSet = await this.client.callback(
      this.redirectUri,
      { code: params.code },
      { code_verifier: params.codeVerifier, nonce: params.expectedNonce },
    );
    const claims = tokenSet.claims();
    return {
      sub: claims.sub,
      iss: claims.iss,
      aud: claims.aud,
      nonce: typeof claims.nonce === 'string' ? claims.nonce : undefined,
      exp: claims.exp,
      nbf: typeof claims.nbf === 'number' ? claims.nbf : undefined,
      claims: {
        role: readClaim(claims, 'roles') ?? readClaim(claims, 'role'),
        department: asString(readClaim(claims, 'department')),
        email: typeof claims.email === 'string' ? claims.email : undefined,
      },
    };
  }
}

/** PKCE verifier generator re-exported from the certified library for callers. */
export const generatePkceVerifier = generators.codeVerifier;

function readClaim(
  claims: Record<string, unknown>,
  key: string,
): string | string[] | undefined {
  const value = claims[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as string[];
  }
  return undefined;
}

function asString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
