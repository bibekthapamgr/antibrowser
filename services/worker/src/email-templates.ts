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

export type EmailKind =
  | 'invitation'
  | 'welcome'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'trial_ending'
  | 'contact_request'
  | 'deletion_request'
  | 'restriction_notice';

const TOPICS: Record<string, string> = {
  sales: 'Sales',
  support: 'Support',
  billing: 'Billing',
  security: 'Security',
  privacy: 'Privacy',
  other: 'Other',
};

/** R4: payment results, trial reminders, and requests for the owner's support address. */
function renderR4(kind: EmailKind, vars: Record<string, string>, brand: string): RenderedEmail | null {
  const ws = line(vars.workspace_name) || 'your workspace';
  const plan = line(vars.plan_name) || 'your plan';
  const link = line(vars.link, 600);
  const button = link ? { label: 'Open billing', href: link } : undefined;
  const withLink = (text: string) => `${text}${link ? `\n\nOpen billing: ${link}` : ''}\n`;
  if (kind === 'payment_succeeded') {
    const lines = [
      `Your ${plan} subscription for ${ws} is active. Thank you.`,
      'The payment provider e-mails the receipt separately. Invoices are also in billing.',
    ];
    return {
      subject: line(`${brand}: ${ws} is on the ${plan} plan`, 200),
      text: withLink(lines.join('\n\n')),
      html: page(brand, 'Subscription active', lines, button),
    };
  }
  if (kind === 'payment_failed') {
    const lines = [
      `A payment for the ${plan} subscription of ${ws} did not go through.`,
      'Everything keeps working while the payment provider retries. Please check the payment method in billing.',
      'Your profiles and data are not deleted because of a failed payment.',
    ];
    return {
      subject: line(`${brand}: a payment for ${ws} failed`, 200),
      text: withLink(lines.join('\n\n')),
      html: page(brand, 'Payment failed', lines, button),
    };
  }
  if (kind === 'trial_ending') {
    const ends = vars.ends_at ? new Date(vars.ends_at).toUTCString() : 'soon';
    const lines = [
      `The free trial of ${ws} ends on ${ends}.`,
      'Choose a plan in billing to keep creating and opening profiles. Nothing is deleted when a trial ends.',
      'You get this reminder because you manage billing for this workspace; you can turn reminders off in your account.',
    ];
    return {
      subject: line(`${brand}: the trial of ${ws} ends soon`, 200),
      text: withLink(lines.join('\n\n')),
      html: page(
        brand,
        'Your trial ends soon',
        lines,
        link ? { label: 'Choose a plan', href: link } : undefined,
      ),
    };
  }
  if (kind === 'contact_request') {
    const topic = TOPICS[vars.topic ?? ''] ?? 'Other';
    const message = [...(vars.message ?? '')].slice(0, 4000).join('');
    const lines = [`Topic: ${topic}`, `From: ${line(vars.name)} <${line(vars.reply_to, 254)}>`, message];
    return {
      subject: line(`Website contact (${topic}) from ${line(vars.name)}`, 200),
      text: `${lines.join('\n\n')}\n`,
      html: page(brand, 'Website contact request', lines),
    };
  }
  if (kind === 'deletion_request') {
    const lines = [
      `An account asked to be deleted: ${line(vars.user_id, 40)}.`,
      'Process it under the published policy (support console). Workspaces it owns alone need another owner or closing first.',
    ];
    return {
      subject: line(`Account deletion request (${line(vars.user_id, 40)})`, 200),
      text: `${lines.join('\n\n')}\n`,
      html: page(brand, 'Account deletion request', lines),
    };
  }
  if (kind === 'restriction_notice') {
    // R5: a staff restriction applied or lifted. The staff member's reason is internal and never sent.
    const security = vars.restriction === 'security';
    const lifted = vars.phase === 'lifted';
    const account = vars.scope === 'account';
    const scope = account ? 'your account' : ws;
    const until = vars.until ? ` until ${new Date(vars.until).toUTCString()}` : '';
    const lines = lifted
      ? [`The restriction on ${scope} was lifted. Everything works as before.`]
      : security
        ? [
            `${account ? 'Your account' : `The workspace ${ws}`} was suspended${until} for security reasons.`,
            'Open profiles were closed and access is paused. Nothing was deleted.',
            'Reply to this e-mail or use the contact form on our website if you have questions.',
          ]
        : [
            `${ws} is restricted${until}: new profiles cannot be created or opened, and people cannot be invited.`,
            'Everything else keeps working: profiles can be closed, backed up, exported and deleted, and billing stays available. Nothing was deleted.',
            'Please contact us to resolve it.',
          ];
    return {
      subject: line(
        lifted
          ? `${brand}: restriction lifted`
          : `${brand}: ${security ? 'suspension' : 'restriction'} notice`,
        200,
      ),
      text: `${lines.join('\n\n')}\n`,
      html: page(brand, lifted ? 'Restriction lifted' : security ? 'Suspended' : 'Restricted', lines),
    };
  }
  return null;
}

export function renderEmail(kind: EmailKind, vars: Record<string, string>, brand: string): RenderedEmail {
  const r4 = renderR4(kind, vars, brand);
  if (r4) return r4;
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
