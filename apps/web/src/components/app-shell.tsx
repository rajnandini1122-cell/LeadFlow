import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { PERMISSIONS, type Permission } from '@leadflow/api-types';
import { useAuth } from '../features/auth/auth-context';
import { useFollowUps } from '../features/leads/use-lead-mutations';
import { useOmnichannelEnabled } from '../features/omnichannel/use-omnichannel-enabled';
import { useInboxCounts, useReviewCount } from '../features/omnichannel/use-conversations';
import { Avatar } from './ui';
import { Copyright, LogoMark } from './brand';
import { OrganizationSwitcher } from './organization-switcher';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** Hidden without this permission. Visibility is convenience — the API guards. */
  permission?: Permission;
  /** Shows a live count; red when it represents something overdue. */
  badge?: 'overdue' | 'review' | 'inbox';
  /**
   * Hidden unless the organization has switched omnichannel capture on.
   * A tenant that has connected no channel never sees an empty queue for a
   * feature it does not use.
   */
  requiresOmnichannel?: boolean;
  /**
   * Exact-match only. Needed for /reports, which would otherwise stay
   * highlighted while /reports/daily is open. Left off for /leads so the tab
   * keeps its highlight on a lead detail page.
   */
  exact?: boolean;
}

/** Navigation from spec §25. */
const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: '◆' },
  { to: '/inbox', label: 'Inbox', icon: '✉', badge: 'inbox', requiresOmnichannel: true },
  { to: '/leads', label: 'Leads', icon: '☰' },
  {
    to: '/leads/review',
    label: 'Channel review',
    icon: '⌸',
    badge: 'review',
    requiresOmnichannel: true,
  },
  { to: '/contacts', label: 'Contacts', icon: '⚈', permission: PERMISSIONS.CONTACT_VIEW },
  { to: '/follow-ups', label: 'Follow-ups', icon: '◷', badge: 'overdue' },
  { to: '/team', label: 'Team', icon: '⚇', permission: PERMISSIONS.USER_VIEW },
  { to: '/reports', label: 'Reports', icon: '▤', permission: PERMISSIONS.REPORT_VIEW, exact: true },
  { to: '/reports/daily', label: 'Daily report', icon: '☀', permission: PERMISSIONS.REPORT_VIEW },
  { to: '/settings', label: 'Settings', icon: '⚙', permission: PERMISSIONS.ORG_VIEW, exact: true },
  {
    to: '/settings/channels',
    label: 'Channels',
    icon: '⇄',
    permission: PERMISSIONS.ORG_VIEW,
    requiresOmnichannel: true,
  },
  {
    to: '/settings/billing',
    label: 'Plan & billing',
    icon: '◫',
    permission: PERMISSIONS.SUBSCRIPTION_VIEW,
  },
  { to: '/settings/security', label: 'Security', icon: '⚿' },
];

export function AppShell(): React.JSX.Element {
  const { user, logout, can } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  // Powers the overdue badge. Uses the API bucket, which is computed in the
  // ORGANIZATION timezone — deriving it here would use the viewer's clock.
  const overdue = useFollowUps('overdue');
  const overdueCount = overdue.data?.length ?? 0;

  // Omnichannel is opt-in per tenant. The count is only fetched once the
  // feature is on, so an organization that never enabled it makes no request
  // for a queue it does not have.
  const omnichannel = useOmnichannelEnabled();
  const review = useReviewCount(omnichannel);
  const reviewCount = review.data?.count ?? 0;

  const inboxCounts = useInboxCounts(omnichannel);
  const inboxCount = inboxCounts.data?.all ?? 0;

  const visible = NAV_ITEMS.filter(
    (item) =>
      (!item.permission || can(item.permission)) &&
      (!item.requiresOmnichannel || omnichannel),
  );

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Sidebar — fixed on desktop, slide-over on mobile */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-60 border-r border-slate-200 bg-white transition-transform lg:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-slate-100 px-5">
          <LogoMark className="h-7 w-7 shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">LeadFlow</p>
            <p className="truncate text-[11px] text-slate-400">No lead left behind</p>
          </div>
        </div>

        <nav className="space-y-0.5 p-3">
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact === true}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  isActive
                    ? 'bg-slate-900 font-medium text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span className={`w-4 text-center ${isActive ? 'text-white' : 'text-slate-400'}`}>
                    {item.icon}
                  </span>
                  <span className="flex-1">{item.label}</span>
                  {item.badge === 'overdue' && overdueCount > 0 && (
                    <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums">
                      {overdueCount}
                    </span>
                  )}
                  {/*
                    Amber, not red: a conversation waiting on a decision is
                    work to do, whereas an overdue follow-up is a promise
                    already broken. Colouring them alike would flatten that.
                  */}
                  {/*
                    Neutral, not amber: the inbox count is how much
                    correspondence exists, not how much is going wrong.
                  */}
                  {item.badge === 'inbox' && inboxCount > 0 && (
                    <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 tabular-nums">
                      {inboxCount}
                    </span>
                  )}
                  {item.badge === 'review' && reviewCount > 0 && (
                    <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums">
                      {reviewCount}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {user && (
          <div className="absolute inset-x-0 bottom-0 border-t border-slate-100 p-3">
            <OrganizationSwitcher />
            <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <Avatar name={user.fullName} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{user.fullName}</p>
                <p className="truncate text-[11px] text-slate-500">{user.organization.name}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="mt-1 w-full rounded-lg px-3 py-1.5 text-left text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            >
              Sign out
            </button>
            <Copyright className="mt-2 px-3 text-[10px]" />
          </div>
        )}
      </aside>

      {menuOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-30 bg-slate-900/20 lg:hidden"
        />
      )}

      <div className="lg:pl-60 print:pl-0">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/80 px-4 backdrop-blur lg:px-8">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
            aria-label="Open menu"
          >
            ☰
          </button>

          <div className="hidden items-center gap-2 lg:flex">
            <span className="text-sm font-medium text-slate-900">{user?.organization.name}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
              {user?.organization.timezone}
            </span>
          </div>

          {overdueCount > 0 && (
            <NavLink
              to="/follow-ups"
              className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
              {overdueCount} overdue follow-{overdueCount === 1 ? 'up' : 'ups'}
            </NavLink>
          )}
        </header>

        <main className="px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
