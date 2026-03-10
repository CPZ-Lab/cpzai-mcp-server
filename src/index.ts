import * as Sentry from '@sentry/node';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import { getOAuthMetadata, registerClient, createAuthCode, exchangeCode } from './oauth.js';
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

// ── OAuth 2.0 ───────────────────────────────────────────────────

app.get('/.well-known/oauth-authorization-server', cors, (_req, res) => {
  res.json(getOAuthMetadata());
});

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
      error: 'Invalid API credentials. Check your key and secret at ai.cpz-lab.com/settings.',
    }));
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
  const { grant_type, code, client_id, redirect_uri, code_verifier } = req.body;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }

  const token = exchangeCode(code, client_id, redirect_uri, code_verifier);
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
