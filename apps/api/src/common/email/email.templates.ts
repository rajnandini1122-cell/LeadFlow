import type { EmailMessage } from './email.types';

/**
 * Plain, table-free HTML with inline styles.
 *
 * Email clients are not browsers: Outlook strips <style> blocks, Gmail clips
 * long messages, and dark mode inverts unpredictably. Simple markup with the
 * link ALSO present as visible text is what survives — and the text/plain part
 * is not an afterthought, it is what screen readers and locked-down corporate
 * clients actually render.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(input: { productName: string; heading: string; body: string; link: string; cta: string }): string {
  const { productName, heading, body, link, cta } = input;

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;">
      <p style="margin:0 0 24px;font-size:14px;font-weight:600;color:#0f172a;">${escapeHtml(productName)}</p>
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;">${escapeHtml(heading)}</h1>
      <div style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#334155;">${body}</div>
      <a href="${link}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:500;">${escapeHtml(cta)}</a>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#64748b;">
        If the button does not work, copy this link into your browser:<br />
        <span style="word-break:break-all;color:#334155;">${link}</span>
      </p>
    </div>
  </body>
</html>`;
}

export function passwordResetEmail(input: {
  productName: string;
  name: string;
  link: string;
  expiresInMinutes: number;
  to: string;
}): EmailMessage {
  const { productName, name, link, expiresInMinutes, to } = input;
  const firstName = name.split(' ')[0] ?? 'there';

  return {
    to: { email: to, name },
    subject: `Reset your ${productName} password`,
    tag: 'password-reset',
    // The "if you didn't request this" line is not boilerplate: for the person
    // whose account is being targeted, this email is the first warning.
    text: [
      `Hi ${firstName},`,
      '',
      `Someone asked to reset the password for your ${productName} account.`,
      '',
      `Set a new password: ${link}`,
      '',
      `This link expires in ${expiresInMinutes} minutes and can be used once.`,
      '',
      'If you did not request this, you can ignore this email — your password',
      'will not change. If you receive these repeatedly, someone may be trying',
      'to access your account.',
    ].join('\n'),
    html: layout({
      productName,
      heading: 'Reset your password',
      body: `
        <p style="margin:0 0 12px;">Hi ${escapeHtml(firstName)},</p>
        <p style="margin:0 0 12px;">Someone asked to reset the password for your ${escapeHtml(productName)} account.</p>
        <p style="margin:0;">This link expires in <strong>${expiresInMinutes} minutes</strong> and can be used once. If you did not request it, you can ignore this email — your password will not change.</p>
      `,
      link,
      cta: 'Set a new password',
    }),
  };
}

export function invitationEmail(input: {
  productName: string;
  organizationName: string;
  inviterName: string;
  role: string;
  link: string;
  expiresInDays: number;
  to: string;
}): EmailMessage {
  const { productName, organizationName, inviterName, role, link, expiresInDays, to } = input;
  const readableRole = role.toLowerCase().replace(/_/g, ' ');

  return {
    to: { email: to },
    subject: `${inviterName} invited you to ${organizationName} on ${productName}`,
    tag: 'invitation',
    text: [
      `${inviterName} has invited you to join ${organizationName} on ${productName}`,
      `as ${readableRole}.`,
      '',
      `Accept the invitation: ${link}`,
      '',
      `This link expires in ${expiresInDays} days and can be used once.`,
      '',
      'If you were not expecting this, you can ignore this email.',
    ].join('\n'),
    html: layout({
      productName,
      heading: `Join ${organizationName}`,
      body: `
        <p style="margin:0 0 12px;"><strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${escapeHtml(organizationName)}</strong> on ${escapeHtml(productName)} as ${escapeHtml(readableRole)}.</p>
        <p style="margin:0;">This link expires in <strong>${expiresInDays} days</strong> and can be used once.</p>
      `,
      link,
      cta: 'Accept invitation',
    }),
  };
}


/**
 * Notifies the sales inbox that someone used the contact form.
 *
 * Deliberately does NOT use the shared `layout` helper: that one is built
 * around a call-to-action button for a link the recipient must click, and
 * there is no link here — the message itself is the payload.
 *
 * Everything the visitor typed is escaped before it reaches the HTML part.
 * This is the one email in the system whose content is written entirely by an
 * anonymous stranger, so it is the one that would carry an injected payload
 * into whatever client the sales team reads mail in.
 */
export function contactEnquiryEmail(input: {
  productName: string;
  to: string;
  name: string;
  email: string;
  company?: string | undefined;
  phone?: string | undefined;
  country?: string | undefined;
  message: string;
  source?: string | undefined;
  reference: string;
}): EmailMessage {
  const rows: [string, string][] = [
    ['Name', input.name],
    ['Email', input.email],
    ...(input.company ? ([['Company', input.company]] as [string, string][]) : []),
    ...(input.phone ? ([['Phone', input.phone]] as [string, string][]) : []),
    ...(input.country ? ([['Country', input.country]] as [string, string][]) : []),
    ...(input.source ? ([['Page', input.source]] as [string, string][]) : []),
    ['Reference', input.reference],
  ];

  const text = [
    `New enquiry from the ${input.productName} website.`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Message:',
    input.message,
    '',
    `Reply directly to ${input.email}.`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;">
      <p style="margin:0 0 24px;font-size:14px;font-weight:600;">${escapeHtml(input.productName)}</p>
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;">New website enquiry</h1>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px;">
        ${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:6px 0;color:#0f172a;word-break:break-word;">${escapeHtml(value)}</td></tr>`,
          )
          .join('')}
      </table>
      <div style="border-top:1px solid #e2e8f0;padding-top:16px;">
        <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Message</p>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#334155;white-space:pre-wrap;">${escapeHtml(input.message)}</p>
      </div>
      <p style="margin:24px 0 0;font-size:13px;color:#64748b;">
        Reply directly to <a href="mailto:${escapeHtml(input.email)}" style="color:#1d6fe8;">${escapeHtml(input.email)}</a>.
      </p>
    </div>
  </body>
</html>`;

  return {
    to: { email: input.to },
    subject: `New enquiry from ${input.name}`,
    text,
    html,
    tag: 'contact-enquiry',
  };
}
