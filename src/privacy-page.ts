export function renderPrivacyPolicy(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CPZAI MCP Connector — Privacy Policy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a; color: #d4d4d4;
      line-height: 1.7; padding: 40px 20px;
    }
    .container { max-width: 720px; margin: 0 auto; }
    h1 { font-size: 28px; color: #fff; margin-bottom: 8px; }
    .updated { color: #737373; font-size: 13px; margin-bottom: 36px; }
    h2 { font-size: 18px; color: #fff; margin-top: 32px; margin-bottom: 12px; }
    p, li { font-size: 14px; margin-bottom: 12px; }
    ul { padding-left: 24px; }
    a { color: #a3a3a3; }
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #262626; font-size: 12px; color: #525252; }
  </style>
</head>
<body>
<div class="container">
  <h1>CPZAI MCP Connector — Privacy Policy</h1>
  <p class="updated">Last updated: March 10, 2026</p>

  <h2>1. Who we are</h2>
  <p>CPZ Capital Ltd ("CPZ Lab", "we", "us") operates the CPZAI platform at <a href="https://ai.cpz-lab.com">ai.cpz-lab.com</a> and the CPZAI MCP connector at <a href="https://mcp.cpz-lab.com">mcp.cpz-lab.com</a>.</p>

  <h2>2. What data we collect</h2>
  <p>When you connect Claude to CPZAI via this MCP connector, we process:</p>
  <ul>
    <li><strong>Authentication credentials</strong> — Your CPZAI API key and secret, transmitted via OAuth 2.0 and stored as an encrypted access token. We never see or store your Claude credentials.</li>
    <li><strong>Tool call data</strong> — The parameters you send to CPZAI tools (strategy queries, order details, market data requests) and the responses returned. These are processed in real time and not retained beyond standard server logs.</li>
    <li><strong>Server logs</strong> — IP address, timestamp, and request metadata for security and debugging. Retained for 30 days.</li>
  </ul>

  <h2>3. How we use your data</h2>
  <ul>
    <li>Authenticate your identity and authorize access to your CPZAI account</li>
    <li>Execute the trading, analytics, and data operations you request</li>
    <li>Monitor for abuse, errors, and security incidents</li>
    <li>Improve the reliability and performance of the connector</li>
  </ul>

  <h2>4. Data sharing</h2>
  <p>We do not sell your data. We share data only with:</p>
  <ul>
    <li><strong>Broker partners</strong> — When you place trades, order data is forwarded to your connected broker (e.g. Alpaca, IBKR). This is necessary to execute your instructions.</li>
    <li><strong>Infrastructure providers</strong> — AWS (hosting), Sentry (error monitoring). These providers process data under contract and are bound by confidentiality obligations.</li>
  </ul>

  <h2>5. Data retention</h2>
  <ul>
    <li><strong>OAuth tokens</strong> — Held in server memory for the duration of the session. Not persisted to disk.</li>
    <li><strong>Server logs</strong> — 30 days.</li>
    <li><strong>Account data</strong> — Retained on the CPZAI platform per your account agreement. Deleting your CPZAI account removes all associated data.</li>
  </ul>

  <h2>6. Security</h2>
  <p>All connections use TLS 1.2+. The MCP server runs behind AWS WAF and ALB with DDoS protection. API credentials are transmitted in HTTP headers and never logged.</p>

  <h2>7. Your rights</h2>
  <p>You can revoke the connector's access at any time by regenerating your API keys in CPZAI Settings. You may request data export or deletion by emailing us.</p>

  <h2>8. Contact</h2>
  <p>For privacy questions or data requests, contact us at <a href="mailto:privacy@cpz-lab.com">privacy@cpz-lab.com</a>.</p>

  <div class="footer">
    &copy; ${new Date().getFullYear()} CPZ Capital Ltd. All rights reserved.
  </div>
</div>
</body>
</html>`;
}
