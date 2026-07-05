import crypto from 'node:crypto';

interface AuthCodeEntry {
  clientId: string;
  apiKey: string;
  apiSecret: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

interface ClientEntry {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName?: string;
}

const authCodes = new Map<string, AuthCodeEntry>();
const clients = new Map<string, ClientEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(code);
  }
}, 60_000);

const BASE_URL = process.env.MCP_BASE_URL || 'https://mcp.cpz-lab.com';
const ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h — short-lived, re-issued on demand

// Access tokens are STATELESS and ENCRYPTED: the credentials are sealed inside
// the token with AES-256-GCM under a server-side key, so (a) the raw key/secret
// never appears in plaintext in the bearer (fixes the "token == plaintext
// key.secret" hole) and (b) any ECS task can decrypt without shared state. An
// intercepted token is useless without the server key. The key is derived from
// MCP_TOKEN_SECRET (shared across tasks); absent that, a per-process random key
// is used (still secure — cross-task resolution just forces a re-auth).
const TOKEN_KEY: Buffer = crypto
  .createHash('sha256')
  .update(process.env.MCP_TOKEN_SECRET || crypto.randomBytes(32).toString('hex'))
  .digest();
if (!process.env.MCP_TOKEN_SECRET) {
  console.warn('[oauth] MCP_TOKEN_SECRET not set — using a per-process token key (OAuth tokens will not resolve across tasks/restarts).');
}

/** Constant-time string comparison. */
function ctEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function getOAuthMetadata() {
  return {
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['read', 'write', 'trade'],
  };
}

export function registerClient(body: Record<string, unknown>): Record<string, unknown> {
  const clientId = `cpz_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const clientSecret = crypto.randomBytes(32).toString('hex');
  const redirectUris = (body.redirect_uris as string[]) || [];

  clients.set(clientId, {
    clientId,
    clientSecret,
    redirectUris,
    clientName: (body.client_name as string) || undefined,
  });

  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: (body.token_endpoint_auth_method as string) || 'client_secret_post',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    client_name: body.client_name,
  };
}

export function getClient(clientId: string): ClientEntry | undefined {
  return clients.get(clientId);
}

/**
 * A redirect_uri is only acceptable if the client is registered AND the exact
 * URI is one of its registered redirect_uris. Prevents auth-code exfiltration to
 * an attacker-controlled URL. Dynamically-registered clients (RFC 7591) are the
 * norm for MCP, so an unknown client is rejected outright.
 */
export function isRedirectUriRegistered(clientId: string, redirectUri: string): boolean {
  const c = clients.get(clientId);
  if (!c) return false;
  return c.redirectUris.includes(redirectUri);
}

export function createAuthCode(
  clientId: string,
  apiKey: string,
  apiSecret: string,
  redirectUri: string,
  codeChallenge?: string,
  codeChallengeMethod?: string,
): string {
  const code = crypto.randomBytes(32).toString('base64url');
  authCodes.set(code, {
    clientId,
    apiKey,
    apiSecret,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  return code;
}

function verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return ctEq(hash, codeChallenge);
}

/**
 * Exchange an auth code for an OPAQUE access token. Requires:
 *  - the code exists, is unexpired, and matches this client_id + redirect_uri,
 *  - the redirect_uri is registered to the client,
 *  - proof of the client: a valid client_secret (confidential) OR a PKCE
 *    verifier that matches the challenge the code was minted with (public).
 * If the code carried a PKCE challenge, the verifier MUST validate regardless.
 */
export function exchangeCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier?: string,
  clientSecret?: string,
): { access_token: string; token_type: string; expires_in: number } | null {
  const entry = authCodes.get(code);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    authCodes.delete(code);
    return null;
  }
  if (entry.clientId !== clientId) return null;
  if (entry.redirectUri !== redirectUri) return null;

  const client = clients.get(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) return null;

  const hasValidSecret = !!clientSecret && ctEq(clientSecret, client.clientSecret);
  const hasValidPkce =
    !!entry.codeChallenge && !!codeVerifier && verifyPKCE(codeVerifier, entry.codeChallenge);

  // If the code was bound to a PKCE challenge, the verifier must match.
  if (entry.codeChallenge && !hasValidPkce) return null;
  // Require SOME proof of the client: secret or PKCE.
  if (!hasValidSecret && !hasValidPkce) return null;

  authCodes.delete(code);

  return {
    access_token: sealToken(entry.apiKey, entry.apiSecret),
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  };
}

/** Encrypt credentials into a self-contained bearer token (AES-256-GCM). */
function sealToken(apiKey: string, apiSecret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv);
  const payload = JSON.stringify({ k: apiKey, s: apiSecret, exp: Date.now() + ACCESS_TOKEN_TTL_MS });
  const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `cpzt_${Buffer.concat([iv, tag, ct]).toString('base64url')}`;
}

/** Resolve/decrypt a stateless access token to credentials, or null if invalid/expired. */
export function resolveAccessToken(token: string): { apiKey: string; apiSecret: string } | null {
  if (!token.startsWith('cpzt_')) return null;
  try {
    const raw = Buffer.from(token.slice(5), 'base64url');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, iv);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(
      Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'),
    );
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return { apiKey: String(payload.k), apiSecret: String(payload.s) };
  } catch {
    return null; // wrong key, tampered, or malformed
  }
}
