export function renderConsentPage(params: {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  error?: string;
}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize CPZAI</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #141414;
      border: 1px solid #262626;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 420px;
      margin: 20px;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 32px;
    }
    .logo img { width: 40px; height: 40px; border-radius: 8px; }
    .logo span { font-size: 20px; font-weight: 600; color: #fff; }
    h1 { font-size: 24px; font-weight: 600; color: #fff; margin-bottom: 8px; }
    .subtitle { color: #737373; font-size: 14px; margin-bottom: 28px; }
    .error { background: #331111; border: 1px solid #662222; color: #ff6b6b; padding: 12px; border-radius: 8px; margin-bottom: 20px; font-size: 13px; }
    label { display: block; font-size: 13px; font-weight: 500; color: #a3a3a3; margin-bottom: 6px; }
    input[type="text"], input[type="password"] {
      width: 100%; padding: 10px 12px; background: #0a0a0a; border: 1px solid #262626;
      border-radius: 8px; color: #fff; font-size: 14px; outline: none; transition: border-color 0.15s;
    }
    input:focus { border-color: #525252; }
    .field { margin-bottom: 16px; }
    .permissions {
      background: #0a0a0a; border: 1px solid #262626; border-radius: 8px;
      padding: 16px; margin: 24px 0;
    }
    .permissions h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #737373; margin-bottom: 12px; }
    .permissions ul { list-style: none; }
    .permissions li {
      font-size: 13px; color: #a3a3a3; padding: 4px 0;
      padding-left: 20px; position: relative;
    }
    .permissions li::before { content: '\\2713'; position: absolute; left: 0; color: #22c55e; font-weight: 600; }
    .btn {
      width: 100%; padding: 12px; background: #fff; color: #000;
      border: none; border-radius: 8px; font-size: 14px; font-weight: 600;
      cursor: pointer; transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.9; }
    .cancel {
      display: block; text-align: center; margin-top: 12px;
      color: #737373; text-decoration: none; font-size: 13px;
    }
    .cancel:hover { color: #a3a3a3; }
    .help { text-align: center; margin-top: 20px; font-size: 12px; color: #525252; }
    .help a { color: #737373; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <img src="https://ai.cpz-lab.com/cpzai-icon.png" alt="CPZAI" onerror="this.style.display='none'">
      <span>CPZAI</span>
    </div>
    <h1>Authorize access</h1>
    <p class="subtitle">Connect your CPZAI account to Claude</p>
    ${params.error ? `<div class="error">${esc(params.error)}</div>` : ''}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${esc(params.clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(params.redirectUri)}">
      ${params.state ? `<input type="hidden" name="state" value="${esc(params.state)}">` : ''}
      ${params.codeChallenge ? `<input type="hidden" name="code_challenge" value="${esc(params.codeChallenge)}">` : ''}
      ${params.codeChallengeMethod ? `<input type="hidden" name="code_challenge_method" value="${esc(params.codeChallengeMethod)}">` : ''}
      <div class="field">
        <label for="api_key">API Key</label>
        <input type="text" id="api_key" name="api_key" placeholder="cpz_key_..." required autocomplete="off">
      </div>
      <div class="field">
        <label for="api_secret">API Secret</label>
        <input type="password" id="api_secret" name="api_secret" placeholder="Your API secret" required autocomplete="off">
      </div>
      <div class="permissions">
        <h3>This will allow Claude to</h3>
        <ul>
          <li>View and manage your trading strategies</li>
          <li>Access market data and portfolio positions</li>
          <li>Run backtests and risk analytics</li>
          <li>Place trades on your behalf</li>
        </ul>
      </div>
      <button type="submit" class="btn">Authorize</button>
      <a href="${esc(params.redirectUri)}?error=access_denied${params.state ? `&state=${esc(params.state)}` : ''}" class="cancel">Cancel</a>
    </form>
    <div class="help">
      Don't have an API key? <a href="https://ai.cpz-lab.com/settings" target="_blank">Create one at cpz-lab.com</a>
    </div>
  </div>
</body>
</html>`;
}
