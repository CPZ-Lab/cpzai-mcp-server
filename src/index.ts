import * as Sentry from '@sentry/node';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, extractCredentials } from './tools.js';
import {
  getOAuthMetadata,
  getProtectedResourceMetadata,
  registerClient,
  createAuthCode,
  exchangeCode,
  isRedirectUriRegistered,
} from './oauth.js';
import { renderConsentPage } from './consent-page.js';
import { renderPrivacyPolicy } from './privacy-page.js';
import { callRestApi } from './api-client.js';

const PORT = parseInt(process.env.PORT || '3001', 10);

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    release: process.env.SENTRY_RELEASE || 'cpzai-mcp-server@1.0.0',
    tracesSampleRate: 0.2,
    profilesSampleRate: 0.1,
  });
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function cors(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'cpzai-mcp-server', timestamp: new Date().toISOString() });
});

// Domain ownership proof for the MCP Registry (registry.modelcontextprotocol.io).
// The registry fetches this file and verifies a signed timestamp against the
// public key, which is what authorises publishing under the com.cpz-lab.mcp
// namespace. Public key only — the private half never leaves our secret store.
const MCP_REGISTRY_AUTH_KEY =
  process.env.MCP_REGISTRY_AUTH_KEY || 'v=MCPv1; k=ed25519; p=TZUiqu6b12nVGzjiRF+10lYCvBikZ5MQSVUW+GOFQZ8=';
app.get('/.well-known/mcp-registry-auth', cors, (_req, res) => {
  res.type('text/plain').send(MCP_REGISTRY_AUTH_KEY);
});

// ── OAuth 2.0 ───────────────────────────────────────────────────

app.get('/.well-known/oauth-authorization-server', cors, (_req, res) => {
  res.json(getOAuthMetadata());
});

// RFC 9728 — MCP clients resolve this (root and /mcp path-suffix variants)
// from the WWW-Authenticate challenge to find the authorization server.
app.get(
  ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
  cors,
  (_req, res) => {
    res.json(getProtectedResourceMetadata());
  },
);

app.options('/oauth/register', cors, (_req, res) => res.sendStatus(204));
app.post('/oauth/register', cors, (req, res) => {
  const client = registerClient(req.body as Record<string, unknown>);
  res.status(201).json(client);
});

app.get('/oauth/authorize', (_req, res) => {
  const q = _req.query as Record<string, string>;
  if (!q.client_id || !q.redirect_uri) {
    res.status(400).send('Missing client_id or redirect_uri');
    return;
  }
  // Never render the consent page (or build a Cancel link) for a redirect_uri
  // that isn't registered to this client — that would let an attacker point the
  // auth code / Cancel navigation at their own origin from a trusted domain.
  if (!isRedirectUriRegistered(q.client_id, q.redirect_uri)) {
    res.status(400).send('Invalid client_id or unregistered redirect_uri.');
    return;
  }
  // PKCE is MANDATORY (OAuth 2.1 / MCP auth spec), and our AS metadata
  // advertises code_challenge_methods_supported: ['S256']. Reject a missing
  // challenge here rather than rendering a consent page whose code can only be
  // redeemed with the DCR-issued client_secret — a public client (every MCP
  // client is one) would otherwise complete a sign-in for a code that carries
  // no interception protection.
  if (!q.code_challenge) {
    res.status(400).send('PKCE required (code_challenge with code_challenge_method=S256).');
    return;
  }
  if (q.code_challenge_method !== 'S256') {
    res.status(400).send('Unsupported code_challenge_method (S256 required).');
    return;
  }
  res.type('html').send(renderConsentPage({
    clientId: q.client_id,
    redirectUri: q.redirect_uri,
    state: q.state,
    codeChallenge: q.code_challenge,
    codeChallengeMethod: q.code_challenge_method,
  }));
});

app.post('/oauth/authorize', async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, api_key, api_secret } = req.body;

  // Reject an unregistered redirect_uri BEFORE minting a code or redirecting.
  if (client_id && redirect_uri && !isRedirectUriRegistered(client_id, redirect_uri)) {
    res.status(400).send('Invalid client_id or unregistered redirect_uri.');
    return;
  }
  // Same mandatory-PKCE rule as the GET handler: a form POST is the second
  // half of the same flow and must not be a way around it.
  if (!code_challenge) {
    res.status(400).send('PKCE required (code_challenge with code_challenge_method=S256).');
    return;
  }
  if (code_challenge_method !== 'S256') {
    res.status(400).send('Unsupported code_challenge_method (S256 required).');
    return;
  }

  if (!client_id || !redirect_uri || !api_key || !api_secret) {
    res.type('html').send(renderConsentPage({
      clientId: client_id || '',
      redirectUri: redirect_uri || '',
      state,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      error: 'Please provide both your API key and secret.',
    }));
    return;
  }

  const verify = await callRestApi({ method: 'GET', path: '/me', apiKey: api_key, apiSecret: api_secret });
  if (!verify.ok) {
    res.type('html').send(renderConsentPage({
      clientId: client_id,
      redirectUri: redirect_uri,
      state,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      // Only 401/403 actually mean "bad key". Reporting every upstream failure
      // as a credential problem sent users hunting for a key that was fine
      // while the real fault (a 404 from a misconfigured API base URL) stayed
      // invisible. Say what actually happened.
      error:
        verify.status === 401 || verify.status === 403
          ? 'Invalid API credentials. Check your key and secret at ai.cpz-lab.com/settings.'
          : `Could not verify your account with the CPZ API (status ${verify.status}). This is a problem on our side, not with your credentials. Please try again, or contact support if it persists.`,
    }));
    if (verify.status !== 401 && verify.status !== 403) {
      console.error('[oauth] credential verification failed upstream', {
        status: verify.status,
        data: verify.data,
      });
    }
    return;
  }

  const code = createAuthCode(client_id, api_key, api_secret, redirect_uri, code_challenge, code_challenge_method);
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(302, url.toString());
});

app.options('/oauth/token', cors, (_req, res) => res.sendStatus(204));
app.post('/oauth/token', cors, (req, res) => {
  const { grant_type, code, client_id, redirect_uri, code_verifier, client_secret } = req.body;
  // Support HTTP Basic client auth (client_secret_basic) in addition to _post.
  let basicSecret: string | undefined;
  let basicId: string | undefined;
  const authz = req.headers['authorization'];
  if (typeof authz === 'string' && authz.startsWith('Basic ')) {
    const decoded = Buffer.from(authz.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx > 0) {
      basicId = decoded.slice(0, idx);
      basicSecret = decoded.slice(idx + 1);
    }
  }

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }

  const token = exchangeCode(
    code,
    client_id || basicId,
    redirect_uri,
    code_verifier,
    client_secret || basicSecret,
  );
  if (!token) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }

  res.json(token);
});

// ── Privacy Policy ──────────────────────────────────────────────

app.get('/privacy', (_req, res) => {
  res.type('html').send(renderPrivacyPolicy());
});

// ── MCP ─────────────────────────────────────────────────────────

app.post('/mcp', async (req, res) => {
  // Challenge unauthenticated requests at the HTTP layer (MCP auth spec).
  // Returning 200 with in-band tool errors — the old behavior — meant OAuth-
  // capable clients never learned they should authenticate, so the only way
  // to use the server was pasting API keys into client config.
  const creds = extractCredentials(req);
  if (!creds.apiKey || !creds.apiSecret) {
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer realm="CPZAI MCP", resource_metadata="${process.env.MCP_BASE_URL || 'https://mcp.cpz-lab.com'}/.well-known/oauth-protected-resource"`,
      )
      .set('Access-Control-Expose-Headers', 'WWW-Authenticate')
      .json({
        error: 'unauthorized',
        error_description:
          'Authenticate via OAuth (authorization server at /.well-known/oauth-authorization-server) or provide X-CPZ-Key/X-CPZ-Secret headers.',
      });
    return;
  }

  const server = new McpServer({
    name: 'cpzai-mcp-server',
    version: '1.0.0',
  });

  registerTools(server, req);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed. Use POST for Streamable HTTP.' }));
});

app.delete('/mcp', async (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed. Sessions are stateless.' }));
});

Sentry.setupExpressErrorHandler(app);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CPZAI MCP server listening on port ${PORT}`);
});
