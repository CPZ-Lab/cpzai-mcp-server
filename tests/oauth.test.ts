import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  registerClient,
  getClient,
  isRedirectUriRegistered,
  createAuthCode,
  exchangeCode,
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
