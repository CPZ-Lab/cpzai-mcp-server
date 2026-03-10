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

export function getOAuthMetadata() {
  return {
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
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
  return hash === codeChallenge;
}

export function exchangeCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier?: string,
): { access_token: string; token_type: string; expires_in: number } | null {
  const entry = authCodes.get(code);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    authCodes.delete(code);
    return null;
  }
  if (entry.clientId !== clientId) return null;
  if (entry.redirectUri !== redirectUri) return null;

  if (entry.codeChallenge) {
    if (!codeVerifier) return null;
    if (!verifyPKCE(codeVerifier, entry.codeChallenge)) return null;
  }

  authCodes.delete(code);
  return {
    access_token: `${entry.apiKey}.${entry.apiSecret}`,
    token_type: 'Bearer',
    expires_in: 31536000,
  };
}

export function getClient(clientId: string): ClientEntry | undefined {
  return clients.get(clientId);
}
