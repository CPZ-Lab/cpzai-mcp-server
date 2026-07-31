export function renderConsentPage(params: {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  error?: string;
}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Keyless path: hand the OAuth params to the CPZAI app, which authenticates
  // the user with their existing session, mints a managed key on approval, and
  // form-posts back to POST /oauth/authorize. Client + redirect URI are
  // re-validated there, so this link carries no trust.
  const keylessQs = new URLSearchParams({ client_id: params.clientId, redirect_uri: params.redirectUri });
  if (params.state) keylessQs.set('state', params.state);
  if (params.codeChallenge) keylessQs.set('code_challenge', params.codeChallenge);
  if (params.codeChallengeMethod) keylessQs.set('code_challenge_method', params.codeChallengeMethod);
  const keylessUrl = `https://ai.cpz-lab.com/mcp-authorize?${keylessQs.toString()}`;

  // The app's own logo asset. Served from the CPZAI web app so the consent page
  // and the sign-in page it hands off to are visually identical.
  const LOGO = 'https://ai.cpz-lab.com/uploads/LogotransparenterHintergrund.png';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>Authorize CPZAI</title>
  <link rel="icon" type="image/png" href="${LOGO}">
  <style>
    /* Design tokens mirror the CPZAI web app sign-in page (ai.cpz-lab.com/auth):
       #0a0a0a base, #0a0f18 gradient mid, #0c99fa brand accent. */
    :root {
      --bg: #0a0a0a;
      --bg-mid: #0a0f18;
      --brand: #0c99fa;
      --fg: #f5f5f5;
      --muted: rgba(245, 245, 245, 0.6);
      --faint: rgba(245, 245, 245, 0.38);
      --line: rgba(255, 255, 255, 0.08);
      --card: rgba(255, 255, 255, 0.028);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px 16px;
      position: relative;
      overflow-x: hidden;
    }
    /* Layered background: gradient wash + brand glows + grid, matching /auth */
    .bg { position: fixed; inset: 0; pointer-events: none; z-index: 0; }
    .bg-gradient { background: linear-gradient(to bottom right, #0a0a0a, var(--bg-mid), #0a0a0a); }
    .glow { position: fixed; border-radius: 9999px; pointer-events: none; z-index: 0; }
    .glow-tr {
      top: 0; right: 0; width: 700px; height: 700px;
      background: rgba(12, 153, 250, 0.05);
      filter: blur(180px); transform: translate(25%, -25%);
    }
    .glow-bl {
      bottom: 0; left: 0; width: 500px; height: 500px;
      background: rgba(12, 153, 250, 0.04);
      filter: blur(140px); transform: translate(-25%, 25%);
    }
    .glow-c {
      top: 50%; left: 50%; width: 600px; height: 600px;
      background: rgba(12, 153, 250, 0.02);
      filter: blur(160px); transform: translate(-50%, -50%);
    }
    .grid {
      position: fixed; inset: 0; z-index: 0; opacity: 0.02; pointer-events: none;
      background-image:
        linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
      background-size: 60px 60px;
    }
    /* Watermark logo, as on the sign-in page */
    .watermark {
      position: fixed; right: -10%; top: 50%; transform: translateY(-50%);
      width: 600px; height: 600px; opacity: 0.03; z-index: 0; pointer-events: none;
    }
    .watermark img {
      width: 100%; height: 100%; object-fit: contain;
      filter: brightness(0) invert(1) sepia(1) saturate(5) hue-rotate(185deg);
    }
    @media (max-width: 767px) { .watermark { display: none; } }

    .wordmark { font-size: 14px; font-weight: 700; color: #fff; letter-spacing: -0.02em; }
    .wordmark i { font-style: normal; color: var(--brand); }

    .card {
      position: relative; z-index: 10;
      width: 100%; max-width: 420px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 32px;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
    }
    .card-logo { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-bottom: 24px; }
    .card-logo img { height: 56px; width: 56px; object-fit: contain; filter: brightness(0) invert(1); }
    .card-logo .wordmark { font-size: 18px; }

    h1 { font-size: 22px; font-weight: 600; color: #fff; letter-spacing: -0.02em; text-align: center; margin-bottom: 8px; }
    .subtitle { color: var(--muted); font-size: 14px; line-height: 1.5; text-align: center; margin-bottom: 24px; }

    .error {
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 12px 14px; border-radius: 10px; margin-bottom: 20px; font-size: 13px; line-height: 1.5;
    }

    /* Typographic scope list — no iconography. */
    .scopes { margin-bottom: 20px; border-top: 1px solid var(--line); }
    .scope { padding: 14px 0; border-bottom: 1px solid var(--line); }
    .scope-label {
      font-size: 11px; font-weight: 600; color: var(--brand);
      text-transform: uppercase; letter-spacing: 0.08em; line-height: 1;
    }
    .scope-detail { font-size: 13px; color: var(--muted); line-height: 1.5; margin-top: 6px; }

    .note {
      font-size: 12px; color: var(--faint); line-height: 1.55;
      padding: 12px 14px; border-radius: 10px;
      background: rgba(255, 255, 255, 0.02); border: 1px solid var(--line);
      margin-bottom: 20px;
    }

    .btn {
      display: block; width: 100%; padding: 12px 16px;
      background: var(--brand); color: #fff;
      border: none; border-radius: 10px;
      font-size: 14px; font-weight: 600; font-family: inherit;
      cursor: pointer; text-align: center; text-decoration: none;
      transition: background 0.15s, transform 0.15s;
    }
    .btn:hover { background: #0b8ae1; }
    .btn:active { transform: translateY(1px); }

    .fallback { margin-top: 14px; }
    .fallback summary {
      cursor: pointer; font-size: 13px; color: var(--muted); text-align: center;
      list-style: none; padding: 6px 0;
    }
    .fallback summary::-webkit-details-marker { display: none; }
    .fallback summary:hover { color: var(--fg); }
    .fallback form { margin-top: 14px; }
    label { display: block; font-size: 12px; font-weight: 500; color: var(--muted); margin-bottom: 6px; }
    input[type="text"], input[type="password"] {
      width: 100%; padding: 10px 12px;
      background: rgba(0, 0, 0, 0.3); border: 1px solid var(--line);
      border-radius: 10px; color: #fff; font-size: 14px; font-family: inherit;
      outline: none; transition: border-color 0.15s;
    }
    input::placeholder { color: rgba(245, 245, 245, 0.25); }
    input:focus { border-color: var(--brand); }
    .field { margin-bottom: 14px; }
    .btn-secondary { background: rgba(255,255,255,0.06); }
    .btn-secondary:hover { background: rgba(255,255,255,0.1); }

    .cancel {
      display: block; text-align: center; margin-top: 14px;
      color: var(--faint); text-decoration: none; font-size: 13px;
    }
    .cancel:hover { color: var(--muted); }
    .help { text-align: center; margin-top: 20px; font-size: 12px; color: var(--faint); line-height: 1.5; }
    .help a { color: var(--muted); text-decoration: none; border-bottom: 1px solid var(--line); }
    .help a:hover { color: var(--brand); border-bottom-color: var(--brand); }

    @media (max-width: 480px) {
      body { padding: 88px 14px 32px; }
      .card { padding: 24px 20px; }
    }
  </style>
</head>
<body>
  <div class="bg bg-gradient"></div>
  <div class="glow glow-tr"></div>
  <div class="glow glow-bl"></div>
  <div class="glow glow-c"></div>
  <div class="grid"></div>
  <div class="watermark"><img src="${LOGO}" alt=""></div>

  <div class="card">
    <div class="card-logo">
      <img src="${LOGO}" alt="CPZAI">
      <span class="wordmark">CPZ<i>AI</i></span>
    </div>
    <h1>Authorize access</h1>
    <p class="subtitle">Connect your CPZAI account to Claude</p>
    ${params.error ? `<div class="error">${esc(params.error)}</div>` : ''}
    <div class="scopes">
      <div class="scope">
        <div class="scope-label">Read</div>
        <div class="scope-detail">Strategies, positions, orders, market data, and risk snapshots</div>
      </div>
      <div class="scope">
        <div class="scope-label">Write</div>
        <div class="scope-detail">Create and update strategies, run backtests, manage webhooks</div>
      </div>
      <div class="scope">
        <div class="scope-label">Trade</div>
        <div class="scope-detail">Place orders through your connected brokers, subject to your pre-trade guards</div>
      </div>
    </div>
    <div class="note">
      Signing in issues a dedicated, revocable credential managed for you — no keys to copy.
      Revoke it any time in Settings under API Keys ("Claude MCP (OAuth)"). Access tokens
      expire automatically every 12 hours.
    </div>
    <a href="${esc(keylessUrl)}" class="btn">Continue with CPZAI</a>
    <details class="fallback">
      <summary>Authorize with an API key instead</summary>
      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="client_id" value="${esc(params.clientId)}">
        <input type="hidden" name="redirect_uri" value="${esc(params.redirectUri)}">
        ${params.state ? `<input type="hidden" name="state" value="${esc(params.state)}">` : ''}
        ${params.codeChallenge ? `<input type="hidden" name="code_challenge" value="${esc(params.codeChallenge)}">` : ''}
        ${params.codeChallengeMethod ? `<input type="hidden" name="code_challenge_method" value="${esc(params.codeChallengeMethod)}">` : ''}
        <div class="field">
          <label for="api_key">API Key</label>
          <input type="text" id="api_key" name="api_key" placeholder="cpz_key_..." required autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label for="api_secret">API Secret</label>
          <input type="password" id="api_secret" name="api_secret" placeholder="Your API secret" required autocomplete="off">
        </div>
        <button type="submit" class="btn btn-secondary">Authorize</button>
      </form>
    </details>
    <a href="${esc(params.redirectUri)}?error=access_denied${params.state ? `&state=${esc(params.state)}` : ''}" class="cancel">Cancel</a>
    <div class="help">
      Manage connected clients any time at
      <a href="https://ai.cpz-lab.com/settings" target="_blank" rel="noopener">ai.cpz-lab.com</a>
    </div>
  </div>
</body>
</html>`;
}
