import crypto from 'node:crypto';

interface ClientEntry {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName?: string;
}

// Best-effort auth-code replay guard. Codes are stateless (sealed), so this
// per-task set only catches replays that land on the same task; the hard
// defense against a stolen code is the PKCE binding sealed inside it.
const usedCodes = new Set<string>();
setInterval(() => usedCodes.clear(), 10 * 60 * 1000);

const BASE_URL = process.env.MCP_BASE_URL || 'https://mcp.cpz-lab.com';
const ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h — short-lived, re-issued on demand

// Refresh tokens exist so long-lived clients (the CLI, IDE plugins) do not push
// the user through a browser twice a day. 30 days matches what Claude Code and
// Codex do, and is short enough that a leaked refresh token has a bounded life.
//
// HONEST LIMITATION: like access tokens and auth codes, refresh tokens here are
// stateless and sealed rather than stored. That buys cross-task resolution with
// no shared state, but it means there is no server-side revocation list, so a
// rotated-away refresh token cannot be invalidated and replay of an old one
// cannot be detected. Rotation below is therefore hygiene, not enforcement. The
// real revocation path is the one users already have: Settings -> API Keys
// revokes the underlying key pair, which instantly kills every token sealed
// around it, refresh tokens included. If a proper revocation store is ever
// added, the jti field below is the hook to key it on.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

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

/**
 * RFC 9728 Protected Resource Metadata. MCP clients (Claude Code, claude.ai)
 * discover the authorization server from this document after receiving a 401
 * challenge on /mcp — without it, the OAuth flow never starts.
 */
export function getProtectedResourceMetadata() {
  return {
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
    scopes_supported: ['read', 'write', 'trade'],
    bearer_methods_supported: ['header'],
    resource_name: 'CPZAI MCP Server',
    resource_documentation: 'https://ai.cpz-lab.com',
  };
}

export function getOAuthMetadata() {
  return {
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['read', 'write', 'trade'],
  };
}

// Client registrations are STATELESS: the registration record (redirect_uris,
// name) is sealed into the client_id itself with AES-256-GCM, and the
// client_secret is an HMAC of the client_id under the same server key. Any ECS
// task can validate a client another task registered — in-memory registries
// broke DCR whenever register/authorize/token hit different tasks.
export function registerClient(body: Record<string, unknown>): Record<string, unknown> {
  const redirectUris = (body.redirect_uris as string[]) || [];
  const clientName = (body.client_name as string) || undefined;

  const payload = JSON.stringify({ r: redirectUris, n: clientName, iat: Date.now() });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv);
  const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const clientId = `cpzc_${Buffer.concat([iv, tag, ct]).toString('base64url')}`;
  const clientSecret = deriveClientSecret(clientId);

  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: (body.token_endpoint_auth_method as string) || 'client_secret_post',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: body.client_name,
  };
}

function deriveClientSecret(clientId: string): string {
  return crypto.createHmac('sha256', TOKEN_KEY).update(`client-secret:${clientId}`).digest('hex');
}

export function getClient(clientId: string): ClientEntry | undefined {
  if (!clientId.startsWith('cpzc_')) return undefined;
  try {
    const raw = Buffer.from(clientId.slice(5), 'base64url');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, iv);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(
      Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'),
    );
    return {
      clientId,
      clientSecret: deriveClientSecret(clientId),
      redirectUris: Array.isArray(payload.r) ? payload.r.map(String) : [],
      clientName: payload.n ? String(payload.n) : undefined,
    };
  } catch {
    return undefined; // wrong key, tampered, or a pre-stateless client_id
  }
}

/**
 * A redirect_uri is only acceptable if the client is registered AND the exact
 * URI is one of its registered redirect_uris. Prevents auth-code exfiltration to
 * an attacker-controlled URL. Dynamically-registered clients (RFC 7591) are the
 * norm for MCP, so an unknown client is rejected outright.
 */
export function isRedirectUriRegistered(clientId: string, redirectUri: string): boolean {
  const c = getClient(clientId);
  if (!c) return false;
  return c.redirectUris.includes(redirectUri);
}

// Auth codes are STATELESS too: the grant (client binding, credentials, PKCE
// challenge, expiry) is sealed into the code itself, so the token exchange can
// land on any task. Single-use is enforced best-effort per task via usedCodes;
// the sealed PKCE challenge is what makes a leaked code unusable.
export function createAuthCode(
  clientId: string,
  apiKey: string,
  apiSecret: string,
  redirectUri: string,
  codeChallenge?: string,
  codeChallengeMethod?: string,
): string {
  const payload = JSON.stringify({
    c: clientId,
    k: apiKey,
    s: apiSecret,
    r: redirectUri,
    ch: codeChallenge,
    chm: codeChallengeMethod,
    exp: Date.now() + 5 * 60 * 1000,
  });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv);
  const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `cpza_${Buffer.concat([iv, tag, ct]).toString('base64url')}`;
}

interface AuthCodePayload {
  c: string;
  k: string;
  s: string;
  r: string;
  ch?: string;
  chm?: string;
  exp: number;
}

function unsealAuthCode(code: string): AuthCodePayload | null {
  if (!code?.startsWith('cpza_')) return null;
  try {
    const raw = Buffer.from(code.slice(5), 'base64url');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
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
): TokenResponse | null {
  const entry = unsealAuthCode(code);
  if (!entry) return null;
  if (usedCodes.has(code)) return null;
  if (entry.exp < Date.now()) return null;
  if (entry.c !== clientId) return null;
  if (entry.r !== redirectUri) return null;

  const client = getClient(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) return null;

  const hasValidSecret = !!clientSecret && ctEq(clientSecret, client.clientSecret);
  const hasValidPkce = !!entry.ch && !!codeVerifier && verifyPKCE(codeVerifier, entry.ch);

  // If the code was bound to a PKCE challenge, the verifier must match.
  if (entry.ch && !hasValidPkce) return null;
  // Require SOME proof of the client: secret or PKCE.
  if (!hasValidSecret && !hasValidPkce) return null;

  usedCodes.add(code);

  return issueTokens(entry.k, entry.s, clientId);
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Mint a fresh access + refresh pair for a set of credentials. */
function issueTokens(apiKey: string, apiSecret: string, clientId: string): TokenResponse {
  return {
    access_token: sealToken(apiKey, apiSecret),
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: sealRefreshToken(apiKey, apiSecret, clientId),
    scope: 'read write trade',
  };
}

interface RefreshPayload {
  k: string;
  s: string;
  /** The client this token was issued to. A token minted for one client is
   *  useless to another, so a leaked refresh token cannot be replayed by a
   *  differently-registered client. */
  c: string;
  /** Unique id per mint. Unused today; the hook for a future revocation store. */
  jti: string;
  exp: number;
}

function sealRefreshToken(apiKey: string, apiSecret: string, clientId: string): string {
  const payload: RefreshPayload = {
    k: apiKey,
    s: apiSecret,
    c: clientId,
    jti: crypto.randomBytes(12).toString('base64url'),
    exp: Date.now() + REFRESH_TOKEN_TTL_MS,
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `cpzr_${Buffer.concat([iv, tag, ct]).toString('base64url')}`;
}

function unsealRefreshToken(token: string): RefreshPayload | null {
  if (!token?.startsWith('cpzr_')) return null;
  try {
    const raw = Buffer.from(token.slice(5), 'base64url');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, iv);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(
      Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'),
    ) as RefreshPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (!payload.k || !payload.s || !payload.c) return null;
    return payload;
  } catch {
    return null; // wrong key, tampered, or malformed
  }
}

/**
 * The refresh_token grant. Rotates: every successful refresh returns a NEW
 * refresh token and the caller is expected to discard the old one.
 *
 * Client proof works the same way as the code exchange. A confidential client
 * presents its secret; a public client (RFC 8252 native apps, which is what the
 * CLI is) presents nothing beyond the client_id, exactly as the spec allows,
 * because the refresh token itself is the secret in that flow. The binding to
 * `c` is what stops that token being useful anywhere else.
 *
 * The refresh does NOT re-validate the underlying API key against the database.
 * It does not need to: the sealed credentials are handed to `rest-api` on the
 * next call, which validates the key, checks it is still approved, and runs the
 * billing gate. A revoked key therefore stops working on the next request
 * regardless of how fresh the bearer around it is.
 */
export function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret?: string,
): TokenResponse | null {
  const payload = unsealRefreshToken(refreshToken);
  if (!payload) return null;

  // The presented client_id must match the one the token was sealed for.
  if (!clientId || !ctEq(payload.c, clientId)) return null;

  const client = getClient(clientId);
  if (!client) return null;

  // A confidential client that sends a secret must send the right one. Sending
  // none is allowed (public client), but sending a wrong one is a hard fail
  // rather than a silent downgrade to the public path.
  if (clientSecret !== undefined && clientSecret !== '' && !ctEq(clientSecret, client.clientSecret)) {
    return null;
  }

  return issueTokens(payload.k, payload.s, clientId);
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
