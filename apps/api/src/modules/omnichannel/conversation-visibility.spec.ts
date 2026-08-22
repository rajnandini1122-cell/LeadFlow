import { PERMISSIONS, type Permission } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { conversationScope, conversationScopeFilter } from './conversation-visibility';

/**
 * Who may see which conversation.
 *
 * These are the assertions that stop the inbox becoming a way to read other
 * people's customers. They are pure, so every combination is cheap to cover —
 * and there is no database in the way of understanding what the rule is.
 */

function principal(permissions: Permission[], userId = 'user-rep'): TenantPrincipal {
  return {
    organizationId: 'org-1',
    userId,
    membershipId: 'm-1',
    role: 'SALES_REP',
    permissions,
    sessionId: 's-1',
  };
}

const REP = principal([PERMISSIONS.LEAD_VIEW_OWN]);
const MANAGER = principal([PERMISSIONS.LEAD_VIEW_OWN, PERMISSIONS.LEAD_VIEW_TEAM], 'user-mgr');
const ADMIN = principal([PERMISSIONS.LEAD_VIEW_OWN, PERMISSIONS.LEAD_VIEW_ALL], 'user-admin');

describe('conversationScope', () => {
  it.each([
    ['a manager', MANAGER],
    ['an administrator', ADMIN],
  ])('gives %s the whole organization', (_label, who) => {
    expect(conversationScope(who, false)).toEqual({ kind: 'ALL' });
  });

  it('restricts a sales rep to their own', () => {
    expect(conversationScope(REP, false)).toEqual({
      kind: 'OWN',
      userId: 'user-rep',
      includeUnassigned: false,
    });
  });

  it('opens the unassigned queue to a rep only when the organization enabled it', () => {
    expect(conversationScope(REP, true).kind).toBe('OWN');
    expect(conversationScope(REP, true)).toMatchObject({ includeUnassigned: true });
  });

  it('does not change what a manager sees when the shared queue is toggled', () => {
    // They could already see everything; the setting is about reps.
    expect(conversationScope(MANAGER, true)).toEqual({ kind: 'ALL' });
  });
});

describe('conversationScopeFilter', () => {
  it('applies no restriction for the whole organization', () => {
    expect(conversationScopeFilter({ kind: 'ALL' })).toBeUndefined();
  });

  it('matches a rep’s own conversations and their own leads', () => {
    const filter = conversationScopeFilter({
      kind: 'OWN',
      userId: 'user-rep',
      includeUnassigned: false,
    });

    expect(filter).toEqual({
      OR: [{ ownerId: 'user-rep' }, { lead: { assignedToId: 'user-rep' } }],
    });
  });

  it('does NOT include unowned conversations by default', () => {
    const filter = conversationScopeFilter({
      kind: 'OWN',
      userId: 'user-rep',
      includeUnassigned: false,
    });

    // The Phase C behaviour this replaces. An unassigned enquiry is a
    // customer's private message, not a noticeboard.
    const clauses = (filter as { OR: Record<string, unknown>[] }).OR;
    expect(clauses.some((clause) => clause['ownerId'] === null)).toBe(false);
  });

  it('includes unowned AND unlinked conversations once the shared queue is on', () => {
    const filter = conversationScopeFilter({
      kind: 'OWN',
      userId: 'user-rep',
      includeUnassigned: true,
    });

    const clauses = (filter as { OR: Record<string, unknown>[] }).OR;
    expect(clauses).toContainEqual({ ownerId: null, leadId: null });
  });

  it('never opens an unowned conversation that belongs to someone else’s lead', () => {
    const filter = conversationScopeFilter({
      kind: 'OWN',
      userId: 'user-rep',
      includeUnassigned: true,
    });

    const clauses = (filter as { OR: Record<string, unknown>[] }).OR;
    // `{ ownerId: null }` alone would match a thread on a colleague's deal
    // whose owner was simply never set. The leadId guard is what prevents it.
    expect(clauses).not.toContainEqual({ ownerId: null });
  });
});
