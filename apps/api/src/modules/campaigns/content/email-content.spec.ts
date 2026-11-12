import {
  applyMergeFields,
  campaignFooter,
  htmlToPlainText,
  normalizeEmailAddress,
  renderEmail,
  sanitizeEmailHtml,
  unknownMergeFields,
} from './email-content';

describe('sanitizing campaign HTML', () => {
  it.each([
    ['<script>alert(1)</script><p>Hi</p>', '<p>Hi</p>'],
    ['<p onclick="steal()">Hi</p>', '<p>Hi</p>'],
    ['<img src="x" onerror="steal()">', ''],
    ['<a href="javascript:steal()">x</a>', '<a rel="noopener noreferrer" target="_blank">x</a>'],
    ['<img src="data:image/png;base64,AAAA">', ''],
    ['<img src="http://tracker.example/p.gif">', ''],
    ['<iframe src="https://evil.example"></iframe><p>ok</p>', '<p>ok</p>'],
    ['<style>body{display:none}</style><p>ok</p>', '<p>ok</p>'],
    ['<form action="https://evil.example"><input name="pw"></form>', ''],
    ['<p style="color:red;position:fixed;background:url(https://x)">x</p>', '<p>x</p>'],
    ['<svg><script>alert(1)</script></svg>', ''],
  ])('%s → %s', (input, expected) => {
    expect(sanitizeEmailHtml(input)).toBe(expected);
  });

  it('keeps ordinary formatting, https images and links', () => {
    const html =
      '<h2>Offer</h2><p style="color:#111827;text-align:center"><strong>20%</strong> off</p>' +
      '<img src="https://cdn.example.com/a.png" alt="A"><a href="https://shop.example.com">Shop</a>';
    const clean = sanitizeEmailHtml(html);
    expect(clean).toContain('<h2>Offer</h2>');
    expect(clean).toContain('style="color:#111827;text-align:center"');
    expect(clean).toContain('<img src="https://cdn.example.com/a.png" alt="A" />');
    expect(clean).toContain('href="https://shop.example.com"');
  });
});

describe('merge fields', () => {
  it('finds unknown fields, case-insensitively accepting known ones', () => {
    expect(
      unknownMergeFields('Hi {{ First_Name }}', '{{company}} {{password}} {{ secret }}'),
    ).toEqual(['password', 'secret']);
  });

  it('escapes values in HTML, so a name cannot inject markup', () => {
    const out = applyMergeFields(
      '<p>Hello {{first_name}}</p>',
      { first_name: '<img src=x onerror=alert(1)>' },
      'html',
    );
    expect(out).toBe('<p>Hello &lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('cannot inject a header through the subject', () => {
    const out = applyMergeFields(
      'Offer for {{company}}',
      { company: 'Acme\r\nBcc: everyone@example.com' },
      'text',
    );
    expect(out).toBe('Offer for Acme Bcc: everyone@example.com');
    expect(out).not.toMatch(/[\r\n]/);
  });

  it('missing values become empty, never the placeholder', () => {
    expect(applyMergeFields('Hi {{first_name}},', {}, 'text')).toBe('Hi ,');
  });
});

describe('rendering one message', () => {
  const base = {
    subject: 'Hello {{first_name}}',
    html: '<p>Dear {{full_name}}, see our <a href="https://x.example">catalogue</a>.</p>',
    text: '',
    values: { first_name: 'Asha', full_name: 'Asha Rao' },
  };

  it('promotional mail always ends with the unsubscribe link, in both parts', () => {
    const out = renderEmail({
      ...base,
      footer: {
        organizationName: 'Acme & Co',
        senderAddress: 'sales@acme.example',
        purpose: 'PROMOTIONAL',
        unsubscribeUrl: 'https://lf.example/unsubscribe/TOKEN',
      },
    });
    expect(out.subject).toBe('Hello Asha');
    expect(out.html).toContain('href="https://lf.example/unsubscribe/TOKEN"');
    expect(out.html).toContain('Acme &amp; Co');
    expect(out.text).toContain('Unsubscribe: https://lf.example/unsubscribe/TOKEN');
    expect(out.text).toContain('Dear Asha Rao, see our catalogue (https://x.example).');
  });

  it('a transactional message says so and carries no marketing unsubscribe', () => {
    const footer = campaignFooter({
      organizationName: 'Acme',
      senderAddress: 'a@acme.example',
      purpose: 'TRANSACTIONAL',
      unsubscribeUrl: null,
    });
    expect(footer.html).toContain('service message');
    expect(footer.html).not.toContain('Unsubscribe');
  });

  it('plain text is derived from HTML when none is given', () => {
    expect(htmlToPlainText('<h2>Title</h2><ul><li>One</li><li>Two</li></ul><p>Bye</p>')).toBe(
      'Title\n• One\n• Two\nBye',
    );
  });
});

describe('recipient addresses', () => {
  it.each([
    ['Asha@Example.COM ', 'asha@example.com'],
    ['first.last+tag@sub.example.co.in', 'first.last+tag@sub.example.co.in'],
  ])('%j → %s', (input, expected) => {
    expect(normalizeEmailAddress(input)).toBe(expected);
  });

  it.each([
    'a@b',
    'no-at-sign.example.com',
    'two@@example.com',
    '"quoted"@example.com',
    'a@example.com, b@example.com',
    'a@example.com;b@example.com',
    'Name <a@example.com>',
    'a b@example.com',
    'a..b@example.com',
    '.a@example.com',
    'a.@example.com',
    'a@-example.com',
    'a@example.com\r\nBcc: x@example.com',
    '',
    null,
  ])('refuses %j', (input) => {
    expect(normalizeEmailAddress(input)).toBeNull();
  });
});
