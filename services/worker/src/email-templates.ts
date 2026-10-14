/**
 * R2 e-mail templates (plain text + a simple HTML part). The brand is configurable (EMAIL_BRAND; no final brand is
 * needed). Every variable is escaped for HTML; links are only the API's own (built from WEB_ORIGIN when queued).
 * Security e-mails (address verification, password reset) are sent by the identity provider with its own templates
 * (scripts/deploy/keycloak-theme).
 */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
/** One line, bounded: names come from people and must not break headers or layout. */
const line = (s: string | undefined, max = 120) =>
  [...(s ?? '').replace(/[\r\n\t]+/g, ' ').trim()].slice(0, max).join('');
const ROLE_NAMES: Record<string, string> = {
  admin: 'an admin',
  operator: 'a member',
  viewer: 'a viewer',
  billing: 'the billing contact',
};

function page(
  brand: string,
  heading: string,
  paragraphs: string[],
  button?: { label: string; href: string },
) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p)}</p>`).join('');
  const cta = button
    ? `<p style="margin:24px 0"><a href="${esc(button.href)}" style="background:#1f6feb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${esc(button.label)}</a></p>
<p style="margin:0 0 16px;color:#57606a;font-size:13px">Or open this address: ${esc(button.href)}</p>`
    : '';
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2328;line-height:1.5;margin:0;padding:24px;background:#f6f8fa">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:24px">
<p style="margin:0 0 8px;font-weight:600;color:#57606a">${esc(brand)}</p>
<h1 style="font-size:20px;margin:0 0 16px">${esc(heading)}</h1>${body}${cta}
</div></body></html>`;
}

export function renderEmail(
  kind: 'invitation' | 'welcome',
  vars: Record<string, string>,
  brand: string,
): RenderedEmail {
  if (kind === 'invitation') {
    const org = line(vars.org_name) || 'a team';
    const who = line(vars.inviter_name) || 'Someone';
    const role = ROLE_NAMES[vars.role ?? ''] ?? 'a member';
    const link = line(vars.link, 600);
    const until = vars.expires_at ? new Date(vars.expires_at).toUTCString() : '';
    const lines = [
      `${who} invited you to join ${org} in ${brand} as ${role}.`,
      'Open the link below, sign in or create an account with this e-mail address, and you will join the team. No payment is needed.',
      ...(until ? [`The invitation is valid until ${until}.`] : []),
      'If you did not expect this invitation, you can ignore this e-mail.',
    ];
    return {
      subject: line(`${who} invited you to ${org} on ${brand}`, 200),
      text: `${lines.join('\n\n')}\n\nAccept the invitation: ${link}\n`,
      html: page(brand, `Join ${org}`, lines, { label: 'Accept the invitation', href: link }),
    };
  }
  const name = line(vars.display_name) || 'there';
  const ws = line(vars.workspace_name) || 'your workspace';
  const app = line(vars.app_url, 600);
  const lines = [
    `Hi ${name},`,
    `your workspace "${ws}" is ready. Download the desktop app, sign in with this e-mail address and you will see your profiles straight away.`,
    'You can invite your team from the Team page at any time.',
  ];
  return {
    subject: line(`Welcome to ${brand}`, 200),
    text: `${lines.join('\n\n')}${app ? `\n\nOpen your account: ${app}` : ''}\n`,
    html: page(
      brand,
      `Welcome to ${brand}`,
      lines,
      app ? { label: 'Open your account', href: app } : undefined,
    ),
  };
}
