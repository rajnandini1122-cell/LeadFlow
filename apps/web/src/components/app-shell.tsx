import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { PERMISSIONS, type Permission } from '@leadflow/api-types';
import { useAuth } from '../features/auth/auth-context';
import { useFollowUps } from '../features/leads/use-lead-mutations';
import { useOmnichannelEnabled } from '../features/omnichannel/use-omnichannel-enabled';
import { useInboxCounts, useReviewCount } from '../features/omnichannel/use-conversations';
import { UserAvatar } from './user-avatar';
import { Copyright, LogoMark } from './brand';
import { OrganizationSwitcher } from './organization-switcher';
import { NotificationsMenu, type AttentionItem } from './notifications-menu';
import { useNotifications } from '../features/notifications/use-notifications';
import { formatApkSize, useApkManifest } from '../lib/use-apk-manifest';

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
/** Exported so a test can assert what each entry requires to be visible. */
export const NAV_ITEMS: NavItem[] = [
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
  /*
   * Customers, then Contacts. A customer is the COMPANY and the long-lived
   * relationship; a contact is a person at one. Putting the company first is
   * what makes the distinction obvious without explaining it.
   */
  {
    to: '/customers',
    label: 'Customers',
    icon: '⌂',
    permission: PERMISSIONS.ACCOUNT_VIEW,
    exact: true,
  },
  /*
   * Retention sits directly under Customers because it IS a customer view —
   * a work queue rather than a report, which is why it comes before the KPI
   * page rather than after it.
   */
  {
    to: '/customers/retention',
    label: 'Retention',
    icon: '↻',
    permission: PERMISSIONS.REPORT_VIEW,
  },
  {
    to: '/customers/kpi',
    label: 'Customer KPIs',
    icon: '◱',
    permission: PERMISSIONS.REPORT_VIEW,
  },
  { to: '/contacts', label: 'Contacts', icon: '⚈', permission: PERMISSIONS.CONTACT_VIEW },
  /*
   * Products sit beside Leads, not under Settings.
   *
   * The catalogue is read by everyone who creates a lead, and the intelligence
   * view is a reporting screen — neither is configuration the way channel
   * integrations are.
   */
  { to: '/products', label: 'Products', icon: '◈', permission: PERMISSIONS.ORG_VIEW, exact: true },
  {
    to: '/products/intelligence',
    label: 'Product KPIs',
    icon: '◐',
    permission: PERMISSIONS.REPORT_VIEW,
  },
  { to: '/follow-ups', label: 'Follow-ups', icon: '◷', badge: 'overdue' },
  { to: '/team', label: 'Team', icon: '⚇', permission: PERMISSIONS.USER_VIEW },
  // "Sales teams", not "Teams": the entry above is the member directory, and
  // two things called Team would be one thing nobody can find.
  { to: '/sales-teams', label: 'Sales teams', icon: '⚑', permission: PERMISSIONS.TEAM_VIEW },
  // Directly above assignment rules, because that is the order they are used
  // in: a territory has to exist before a rule can route one.
  { to: '/territories', label: 'Territories', icon: '◈', permission: PERMISSIONS.TERRITORY_VIEW },
  {
    to: '/assignment-rules',
    label: 'Assignment rules',
    icon: '⇄',
    permission: PERMISSIONS.ASSIGNMENT_RULE_VIEW,
  },
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

  // Due TODAY, alongside overdue. Both come from the API's own buckets, which
  // are computed in the ORGANIZATION's timezone — deriving them here would use
  // the viewer's clock and put the day boundary in the wrong place.
  const dueToday = useFollowUps('today');
  const dueTodayCount = dueToday.data?.length ?? 0;

  // The published Android build, if there is one. Null means no link is shown.
  const apk = useApkManifest();

  /*
   * Everything that needs a person, gathered from counts already on screen.
   *
   * No new requests and no new backend: these are the same queries that power
   * the nav badges. Zero-count entries are dropped by the menu, so an
   * organization without omnichannel simply has fewer rows rather than a list
   * of noughts.
   */
  /*
   * Persisted notifications, alongside the derived counts below.
   *
   * Both belong. The derived items say what the current data needs; these say
   * what the system has already told you — and they are the same rows the
   * Android app shows, so a reminder read on a phone is read here too.
   */
  const notifications = useNotifications();
  const unreadNotifications = notifications.data?.unread ?? 0;

  const attention: AttentionItem[] = [
    {
      id: 'notifications',
      count: unreadNotifications,
      label: `Unread notification${unreadNotifications === 1 ? '' : 's'}`,
      to: '/follow-ups',
      tone: 'urgent',
    },
    {
      id: 'overdue',
      count: overdueCount,
      label: `Overdue follow-${overdueCount === 1 ? 'up' : 'ups'}`,
      to: '/follow-ups',
      tone: 'urgent',
    },
    {
      id: 'due-today',
      count: dueTodayCount,
      label: 'Follow-ups due today',
      to: '/follow-ups',
      tone: 'normal',
    },
    {
      id: 'review',
      count: reviewCount,
      label: 'Conversations needing review',
      to: '/leads/review',
      tone: 'normal',
    },
    {
      id: 'unassigned',
      count: omnichannel ? (inboxCounts.data?.unassigned ?? 0) : 0,
      label: 'Unassigned conversations',
      to: '/inbox',
      tone: 'normal',
    },
  ];

  const visible = NAV_ITEMS.filter(
    (item) =>
      (!item.permission || can(item.permission)) &&
      (!item.requiresOmnichannel || omnichannel),
  );

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Sidebar — fixed on desktop, slide-over on mobile */}
      {/*
        A flex COLUMN, so the nav can scroll.

        It was previously a plain block with the user panel positioned
        absolutely at the bottom, which meant a nav list taller than the
        viewport simply ran underneath that panel with no way to reach the
        items below — on a short window, or once enough nav items were
        permitted, the last entries became unreachable. Now the header and the
        user panel keep their size and the nav takes the remaining space and
        scrolls within it.
      */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-slate-200 bg-white transition-transform lg:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-slate-100 px-5">
          <LogoMark className="h-7 w-7 shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">LeadFlow</p>
            <p className="truncate text-[11px] text-slate-400">No lead left behind</p>
          </div>
        </div>

        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-3">
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

        {/*
          * The Android app, in the menu.
          *
          * A plain download link rather than a route, and rendered only when an
          * APK has actually been published — the same manifest the settings
          * card and the marketing page read, so the three cannot disagree about
          * what is on offer. Sitting inside the scrollable nav rather than the
          * pinned footer keeps the user block where people expect it.
          */}
        {apk && (
          <div className="shrink-0 border-t border-slate-100 p-3">
            <a
              href={apk.url}
              download={apk.fileName}
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
            >
              <span className="w-4 text-center text-slate-400" aria-hidden="true">
                ⬇
              </span>
              <span className="flex-1">Android app</span>
              <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">
                {formatApkSize(apk.bytes)}
              </span>
            </a>
          </div>
        )}

        {user && (
          // No longer absolutely positioned: it is the last flex child, so it
          // sits at the bottom without overlapping the scrollable nav above it.
          <div className="shrink-0 border-t border-slate-100 p-3">
            <OrganizationSwitcher />
            <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <UserAvatar name={user.fullName} avatarUrl={user.avatarUrl} size="sm" />
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

          <div className="flex items-center gap-2">
            {/*
              * The overdue pill stays. It is the one thing urgent enough to
              * name in the header rather than hide behind a click, and it has
              * been there since before the bell existed.
              */}
            {overdueCount > 0 && (
              <NavLink
                to="/follow-ups"
                className="hidden items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100 sm:flex"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
                {overdueCount} overdue follow-{overdueCount === 1 ? 'up' : 'ups'}
              </NavLink>
            )}

            <NotificationsMenu items={attention} />
          </div>
        </header>

        <main className="px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
