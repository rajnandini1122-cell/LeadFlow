import { SendingAllowlist } from './sending-allowlist';

const ORG = '01a0d17f-4788-7118-9999-fe48bb29a870';
const policy = (values: Record<string, unknown>) =>
  new SendingAllowlist({ get: ((key: string) => values[key]) as never });

describe('SendingAllowlist (fails closed)', () => {
  it.each([
    ['nothing set', {}],
    ['addresses but no organization', { EMAIL_RECIPIENT_ALLOWLIST: 'a@x.example' }],
    ['organization but no addresses', { EMAIL_ALLOWED_ORGANIZATION_ID: ORG }],
    ['blank list', { EMAIL_ALLOWED_ORGANIZATION_ID: ORG, EMAIL_RECIPIENT_ALLOWLIST: ' , ' }],
    ['unrestricted as a string other than true', { EMAIL_SENDING_UNRESTRICTED: 'yes' }],
  ])('refuses everyone with %s', (_label, values) => {
    expect(policy(values).allows(ORG, 'a@x.example')).toBe(false);
  });

  it('allows only listed addresses (case-insensitive, trimmed) in the one organization', () => {
    const p = policy({
      EMAIL_ALLOWED_ORGANIZATION_ID: ` ${ORG.toUpperCase()} `,
      EMAIL_RECIPIENT_ALLOWLIST: ' A@X.example , b@x.example ',
    });
    expect(p.allows(ORG, 'a@x.example')).toBe(true);
    expect(p.allows(ORG, ' B@X.EXAMPLE ')).toBe(true);
    expect(p.allows(ORG, 'c@x.example')).toBe(false);
    expect(p.allows('01a0d17f-0000-7000-8000-000000000000', 'a@x.example')).toBe(false);
  });

  it('EMAIL_SENDING_UNRESTRICTED=true (parsed to true) is the only way to lift it', () => {
    expect(policy({ EMAIL_SENDING_UNRESTRICTED: true }).allows(ORG, 'anyone@x.example')).toBe(true);
  });

  describe('lists (strict, for test emails to a typed address)', () => {
    const listed = {
      EMAIL_ALLOWED_ORGANIZATION_ID: ORG,
      EMAIL_RECIPIENT_ALLOWLIST: 'a@x.example',
    };

    it('accepts only an exact listed address in the one organization', () => {
      const p = policy(listed);
      expect(p.lists(ORG, ' A@X.example ')).toBe(true);
      expect(p.lists(ORG, 'b@x.example')).toBe(false);
      expect(p.lists(ORG, 'a@x.example.evil')).toBe(false);
      expect(p.lists(ORG, 'xa@x.example')).toBe(false);
      expect(p.lists('01a0d17f-0000-7000-8000-000000000000', 'a@x.example')).toBe(false);
    });

    it('EMAIL_SENDING_UNRESTRICTED=true does NOT lift it', () => {
      const open = policy({ EMAIL_SENDING_UNRESTRICTED: true });
      expect(open.allows(ORG, 'anyone@x.example')).toBe(true);
      expect(open.lists(ORG, 'anyone@x.example')).toBe(false);
      const both = policy({ ...listed, EMAIL_SENDING_UNRESTRICTED: true });
      expect(both.lists(ORG, 'a@x.example')).toBe(true);
      expect(both.lists(ORG, 'b@x.example')).toBe(false);
    });

    it.each([
      ['nothing set', {}],
      ['addresses but no organization', { EMAIL_RECIPIENT_ALLOWLIST: 'a@x.example' }],
      ['organization but no addresses', { EMAIL_ALLOWED_ORGANIZATION_ID: ORG }],
    ])('refuses everyone with %s', (_label, values) => {
      expect(policy(values).lists(ORG, 'a@x.example')).toBe(false);
    });
  });

  it('explains the refusal', () => {
    expect(policy({}).refusal(ORG)).toContain('no recipients are approved');
    const p = policy({
      EMAIL_ALLOWED_ORGANIZATION_ID: ORG,
      EMAIL_RECIPIENT_ALLOWLIST: 'a@x.example',
    });
    expect(p.refusal('01a0d17f-0000-7000-8000-000000000000')).toContain('another organization');
    expect(p.refusal(ORG)).toContain('approved internal addresses');
  });
});
