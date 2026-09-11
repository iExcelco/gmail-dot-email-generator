import { AgentMailClient } from 'agentmail';

const DEFAULT_INBOX_ID = 'iexcelagent@agentmail.to';

let client;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getClient() {
  if (client) return client;

  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    throw new Error('AGENTMAIL_API_KEY is not configured');
  }

  client = new AgentMailClient({ apiKey });
  return client;
}

function renderVariationRows(variations, limit = 200) {
  const capped = variations.slice(0, limit);
  return capped.map((v, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    return `<tr>
      <td style="padding:8px 14px;background-color:${bg};font-size:14px;font-family:'Courier New',Courier,monospace;color:#0f172a;border-bottom:1px solid #e2e8f0;">${escapeHtml(v)}</td>
    </tr>`;
  }).join('');
}

function renderEmailHtml({ baseEmail, mode, variations }) {
  const count = variations.length;
  const modeLabel = mode === 'all' ? 'All Combinations' : 'Word Split';
  const cappedNote = count > 200
    ? `<tr><td style="padding:10px 14px;font-size:12px;color:#64748b;background-color:#fffbeb;border-bottom:1px solid #e2e8f0;">Showing first 200 of ${count} variations. Use the generator to copy the full list.</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f8fafc" style="background-color:#f8fafc;border-collapse:collapse;">
      <tr>
        <td align="center" valign="top" style="padding:24px 12px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;border-collapse:collapse;">
            <tr>
              <td style="padding:24px;border-bottom:1px solid #e2e8f0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                  <tr>
                    <td align="left" valign="middle">
                      <img src="https://iexcel.co/iexcel_logo.png" alt="iExcel" style="height:36px;width:auto;" />
                    </td>
                  </tr>
                  <tr>
                    <td style="padding-top:6px;font-size:11px;font-style:italic;color:#64748b;">Digital Marketing, Focused On Growth</td>
                  </tr>
                  <tr>
                    <td style="padding-top:12px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                        <tr><td height="6" bgcolor="#1e3a8a" style="background-color:#1e3a8a;line-height:6px;font-size:6px;">&nbsp;</td></tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                  <tr>
                    <td style="font-size:20px;font-weight:700;color:#0f172a;padding-bottom:6px;">Your Gmail Dot Variations</td>
                  </tr>
                  <tr>
                    <td style="font-size:14px;color:#475569;padding-bottom:16px;">
                      We generated <strong>${count}</strong> dot variation${count === 1 ? '' : 's'} for <strong>${escapeHtml(baseEmail)}</strong> using <strong>${modeLabel}</strong> mode. Every variation below lands in the same inbox.
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #e2e8f0;">
                  <tr>
                    <td style="padding:12px 14px;background-color:#0f172a;color:#ffffff;font-size:13px;font-weight:700;letter-spacing:0.05em;">VARIATIONS</td>
                  </tr>
                  ${cappedNote}
                  ${renderVariationRows(variations)}
                </table>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-collapse:collapse;">
                  <tr>
                    <td style="padding:14px;background-color:#eff6ff;border:1px solid #bfdbfe;font-size:13px;color:#1e40af;">
                      <strong>How it works:</strong> Gmail ignores dots in the local part of your address. So <em>j.ohn</em>@gmail.com and <em>john</em>@gmail.com both reach the same inbox. Use these variations to test email flows, sign up for multiple accounts, or segment marketing funnels.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td bgcolor="#1f2937" style="padding:20px;background-color:#1f2937;font-size:12px;color:#e5e7eb;">
                <div>Digital Marketing, Focused On Growth</div>
                <div style="padding-top:6px;color:#cbd5e1;">Powered by Autonomous AI Agents</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderEmailText({ baseEmail, mode, variations }) {
  const modeLabel = mode === 'all' ? 'All Combinations' : 'Word Split';
  const capped = variations.slice(0, 200);
  const lines = [
    `Your Gmail Dot Variations`,
    '',
    `Base email: ${baseEmail}`,
    `Mode: ${modeLabel}`,
    `Total variations: ${variations.length}`,
    '',
    ...capped,
    '',
    variations.length > 200 ? `(Showing first 200 of ${variations.length}. Use the generator to copy the full list.)\n` : '',
    'How it works: Gmail ignores dots in the local part of your address.',
    'Use these variations to test email flows, sign up for multiple accounts, or segment marketing funnels.',
    '',
    '-- iExcel | Digital Marketing, Focused On Growth',
  ];
  return lines.join('\n');
}

export async function sendResultsEmail({ to, baseEmail, mode, variations }) {
  if (!to) {
    throw new Error('Recipient email is required');
  }

  // EMAIL-GDV-500: Detailed try/catch around the AgentMail send so we get
  // actionable logs when the prod 500 fires (template error vs API error vs
  // missing env). Caller (server.js) catches and returns 200 with
  // emailQueued:false so the user never sees a 500.
  let inboxId;
  let html;
  let text;
  try {
    getClient(); // fail fast here (setup error) when the API key is missing
    inboxId = process.env.AGENTMAIL_INBOX_ID || DEFAULT_INBOX_ID;

    const payload = { baseEmail, mode, variations };
    html = renderEmailHtml(payload);
    text = renderEmailText(payload);
  } catch (renderError) {
    console.error('[email-service] template/setup error:', {
      message: renderError && renderError.message,
      hasApiKey: !!process.env.AGENTMAIL_API_KEY,
      inboxId: process.env.AGENTMAIL_INBOX_ID || DEFAULT_INBOX_ID,
      to,
      mode,
      variationCount: Array.isArray(variations) ? variations.length : 0,
    });
    throw renderError;
  }

  try {
    await getClient().inboxes.messages.send(inboxId, {
      to,
      subject: `Your Gmail Dot Variations for ${baseEmail}`,
      text,
      html,
    });
  } catch (sendError) {
    console.error('[email-service] AgentMail send error:', {
      message: sendError && sendError.message,
      name: sendError && sendError.name,
      status: sendError && (sendError.statusCode || sendError.status),
      body: sendError && sendError.body,
      to,
      inboxId,
      mode,
      variationCount: variations.length,
    });
    throw sendError;
  }

  return { ok: true, inboxId };
}
