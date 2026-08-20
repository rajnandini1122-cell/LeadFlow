import { NavLink, Outlet } from 'react-router-dom';
import { PERMISSIONS, type Permission } from '@idea001/api-types';
import { useAuth } from '../features/auth/auth-context';

interface NavItem {
  to: string;
  label: string;
  /** Hidden without this permission. Visibility is convenience — the API is the guard. */
  permission?: Permission;
}

/** Navigation from spec §25. */
const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/leads', label: 'Leads' },
  { to: '/follow-ups', label: 'Follow-ups' },
  { to: '/team', label: 'Team', permission: PERMISSIONS.USER_VIEW },
  { to: '/reports', label: 'Reports', permission: PERMISSIONS.REPORT_VIEW },
  { to: '/settings', label: 'Settings', permission: PERMISSIONS.ORG_VIEW },
];

export function AppShell(): React.JSX.Element {
  const { user, logout, can } = useAuth();

  const visible = NAV_ITEMS.filter((item) => !item.permission || can(item.permission));

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-tight text-slate-900">IDEA001</span>
            {user && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {user.organization.name}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4">
            {user && (
              <div className="text-right">
                <p className="text-sm text-slate-900">{user.fullName}</p>
                <p className="text-xs text-slate-500">{user.role}</p>
              </div>
            )}
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
            >
              Sign out
            </button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4">
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${
                  isActive
                    ? 'border-slate-900 font-medium text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-900'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
