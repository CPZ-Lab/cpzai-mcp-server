import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  registerClient,
  getClient,
  isRedirectUriRegistered,
  createAuthCode,
  exchangeCode,
  refreshAccessToken,
  resolveAccessToken,
  getProtectedResourceMetadata,
} from '../src/oauth.js';

const REDIRECT = 'http://localhost:33418/callback';

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('stateless OAuth', () => {
  it('registers a client whose record is recoverable from the client_id alone', () => {
    const reg = registerClient({ client_name: 'claude-code', redirect_uris: [REDIRECT] });
    const client = getClient(reg.client_id as string);
    expect(client).toBeDefined();
    expect(client!.redirectUris).toEqual([REDIRECT]);
    expect(client!.clientName).toBe('claude-code');
    expect(isRedirectUriRegistered(reg.client_id as string, REDIRECT)).toBe(true);
    expect(isRedirectUriRegistered(reg.client_id as string, 'https://evil.example/cb')).toBe(false);
  });

  it('rejects unknown and tampered client_ids', () => {
    expect(getClient('cpz_legacy1234567890')).toBeUndefined();
    const reg = registerClient({ redirect_uris: [REDIRECT] });
    const tampered = (reg.client_id as string).slice(0, -4) + 'AAAA';
    expect(getClient(tampered)).toBeUndefined();
  });

  it('completes the full code flow with PKCE and yields a working access token', () => {
    const reg = registerClient({ redirect_uris: [REDIRECT] });
    const clientId = reg.client_id as string;
    const { verifier, challenge } = pkcePair();

    const code = createAuthCode(clientId, 'cpz_key_abc', 'supersecret', REDIRECT, challenge, 'S256');
    const token = exchangeCode(code, clientId, REDIRECT, verifier, undefined);
    expect(token).not.toBeNull();
    expect(token!.token_type).toBe('Bearer');

    const creds = resolveAccessToken(token!.access_token);
    expect(creds).toEqual({ apiKey: 'cpz_key_abc', apiSecret: 'supersecret' });
  });

  it('refuses exchange with a wrong PKCE verifier, wrong client, or replayed code', () => {
    const reg = registerClient({ redirect_uris: [REDIRECT] });
    const clientId = reg.client_id as string;
    const { verifier, challenge } = pkcePair();
    const code = createAuthCode(clientId, 'k', 's', REDIRECT, challenge, 'S256');

    expect(exchangeCode(code, clientId, REDIRECT, 'wrong-verifier', undefined)).toBeNull();

    const other = registerClient({ redirect_uris: [REDIRECT] });
    expect(exchangeCode(code, other.client_id as string, REDIRECT, verifier, undefined)).toBeNull();

    expect(exchangeCode(code, clientId, REDIRECT, verifier, undefined)).not.toBeNull();
    // Same-task replay is rejected.
    expect(exchangeCode(code, clientId, REDIRECT, verifier, undefined)).toBeNull();
  });

  it('accepts client_secret as client proof when no PKCE was used', () => {
    const reg = registerClient({ redirect_uris: [REDIRECT] });
    const clientId = reg.client_id as string;
    const code = createAuthCode(clientId, 'k', 's', REDIRECT);
    expect(exchangeCode(code, clientId, REDIRECT, undefined, 'not-the-secret')).toBeNull();
    const code2 = createAuthCode(clientId, 'k', 's', REDIRECT);
    expect(exchangeCode(code2, clientId, REDIRECT, undefined, reg.client_secret as string)).not.toBeNull();
  });

  it('serves RFC 9728 protected-resource metadata pointing at the AS', () => {
    const meta = getProtectedResourceMetadata();
    expect(meta.resource).toMatch(/\/mcp$/);
    expect(meta.authorization_servers.length).toBe(1);
  });
});

describe('refresh_token grant', () => {
  function signedIn() {
    const reg = registerClient({ redirect_uris: [REDIRECT] });
    const clientId = reg.client_id as string;
    const { verifier, challenge } = pkcePair();
    const code = createAuthCode(clientId, 'cpz_key_abc', 'supersecret', REDIRECT, challenge, 'S256');
    const token = exchangeCode(code, clientId, REDIRECT, verifier, undefined);
    return { clientId, clientSecret: reg.client_secret as string, token: token! };
  }

  it('issues a refresh token alongside the access token', () => {
    const { token } = signedIn();
    expect(token.refresh_token).toMatch(/^cpzr_/);
    expect(token.expires_in).toBe(12 * 60 * 60);
  });

  it('exchanges a refresh token for a working access token, as a public client', () => {
    const { clientId, token } = signedIn();

    const refreshed = refreshAccessToken(token.refresh_token, clientId, undefined);
    expect(refreshed).not.toBeNull();

    // The new access token must resolve to the same underlying credentials.
    const creds = resolveAccessToken(refreshed!.access_token);
    expect(creds).toEqual({ apiKey: 'cpz_key_abc', apiSecret: 'supersecret' });
  });

  it('rotates: each refresh returns a different refresh token', () => {
    const { clientId, token } = signedIn();
    const first = refreshAccessToken(token.refresh_token, clientId, undefined)!;
    const second = refreshAccessToken(first.refresh_token, clientId, undefined)!;
    expect(first.refresh_token).not.toBe(token.refresh_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
  });

  it('accepts a correct client_secret and rejects a wrong one', () => {
    const { clientId, clientSecret, token } = signedIn();
    expect(refreshAccessToken(token.refresh_token, clientId, clientSecret)).not.toBeNull();
    expect(refreshAccessToken(token.refresh_token, clientId, 'not-the-secret')).toBeNull();
  });

  it('refuses a refresh token presented by a different client', () => {
    const { token } = signedIn();
    const other = registerClient({ redirect_uris: [REDIRECT] });
    expect(refreshAccessToken(token.refresh_token, other.client_id as string, undefined)).toBeNull();
  });

  it('rejects tampered, malformed and non-refresh tokens', () => {
    const { clientId, token } = signedIn();
    const tampered = token.refresh_token.slice(0, -4) + 'AAAA';
    expect(refreshAccessToken(tampered, clientId, undefined)).toBeNull();
    expect(refreshAccessToken('cpzr_garbage', clientId, undefined)).toBeNull();
    // An access token is not a refresh token, even though both are sealed.
    expect(refreshAccessToken(token.access_token, clientId, undefined)).toBeNull();
  });

  it('refuses an empty client_id', () => {
    const { token } = signedIn();
    expect(refreshAccessToken(token.refresh_token, '', undefined)).toBeNull();
  });
});
