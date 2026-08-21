import {
  ADMIN_ROLE_KEYS,
  isAdministrativeRole,
  losesAdminStanding,
} from './administrators';

describe('isAdministrativeRole', () => {
  it('treats OWNER and ADMIN as administrators', () => {
    expect(isAdministrativeRole('OWNER')).toBe(true);
    expect(isAdministrativeRole('ADMIN')).toBe(true);
  });

  it('does NOT treat MANAGER as an administrator', () => {
    // A manager can reassign leads and read reports, but cannot invite, remove
    // or reconfigure. An organization with only managers cannot be
    // administered, however senior they sound.
    expect(isAdministrativeRole('MANAGER')).toBe(false);
  });

  it('does not treat SALES_REP as an administrator', () => {
    expect(isAdministrativeRole('SALES_REP')).toBe(false);
  });

  it('is derived from permissions, not a hardcoded name list', () => {
    // The property that matters: adding a role to the matrix classifies it
    // automatically. A name list would silently stop being true.
    expect(ADMIN_ROLE_KEYS).toEqual(expect.arrayContaining(['OWNER', 'ADMIN']));
    expect(ADMIN_ROLE_KEYS).not.toContain('MANAGER');
    expect(ADMIN_ROLE_KEYS).not.toContain('SALES_REP');
  });
});

describe('losesAdminStanding', () => {
  const activeOwner = { role: 'OWNER' as const, status: 'ACTIVE' };

  it('is true when an admin is demoted to a non-admin role', () => {
    expect(losesAdminStanding(activeOwner, { role: 'SALES_REP' })).toBe(true);
    expect(losesAdminStanding(activeOwner, { role: 'MANAGER' })).toBe(true);
  });

  it('is true when an active admin is suspended', () => {
    expect(losesAdminStanding(activeOwner, { status: 'SUSPENDED' })).toBe(true);
  });

  it('is false when an admin moves between administrative roles', () => {
    expect(losesAdminStanding(activeOwner, { role: 'ADMIN' })).toBe(false);
  });

  it('is false for an unrelated change', () => {
    // PATCH semantics: an absent field is "not mentioned", not "set to the
    // same value". Treating absence as a change would block every profile edit.
    expect(losesAdminStanding(activeOwner, {})).toBe(false);
  });

  it('is false when the member was never an administrator', () => {
    expect(losesAdminStanding({ role: 'SALES_REP', status: 'ACTIVE' }, { status: 'SUSPENDED' })).toBe(
      false,
    );
  });

  it('is false when the member was already inactive', () => {
    // They were not propping up the organization to begin with.
    expect(losesAdminStanding({ role: 'OWNER', status: 'SUSPENDED' }, { role: 'SALES_REP' })).toBe(
      false,
    );
  });
});
