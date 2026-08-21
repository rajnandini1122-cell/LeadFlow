import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Copyright, Logo } from '../../components/brand';

const NAV = [
  { to: '/features', label: 'Features' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/about', label: 'About' },
];

/**
 * Chrome for the public site.
 *
 * Deliberately separate from AppShell. The two answer different questions — a
 * visitor is deciding whether to sign up, a user is doing their job — and
 * sharing one layout between them means every change to either has to be
 * checked against the other.
 */
export function MarketingLayout(): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingHeader />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <MarketingFooter />
    </div>
  );
}

function MarketingHeader(): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Close the menu on navigation, or it stays open covering the page arrived at.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    `text-sm transition ${isActive ? 'font-medium text-slate-900' : 'text-slate-600 hover:text-slate-900'}`;

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      {/* Without this a keyboard user tabs the whole nav on every page load. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-slate-900 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" aria-label="LeadFlow home">
          <Logo />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-7 md:flex">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={linkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Link
            to="/login"
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            Sign in
          </Link>
          <Link
            to="/register"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            Get started
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          className="rounded-lg p-2 text-slate-600 transition hover:bg-slate-100 md:hidden"
        >
          <span aria-hidden>{menuOpen ? '✕' : '☰'}</span>
        </button>
      </div>

      {menuOpen && (
        <div id="mobile-nav" className="border-t border-slate-100 px-4 py-3 md:hidden">
          <nav aria-label="Main" className="flex flex-col gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className="rounded-lg px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100"
              >
                {item.label}
              </NavLink>
            ))}
            <hr className="my-2 border-slate-100" />
            <Link
              to="/login"
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Sign in
            </Link>
            <Link
              to="/register"
              className="rounded-lg bg-slate-900 px-3 py-2 text-center text-sm font-medium text-white"
            >
              Get started
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}

function MarketingFooter(): React.JSX.Element {
  return (
    <footer className="border-t border-slate-200 py-10">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
          <div className="flex flex-col items-center gap-1 md:items-start">
            <Logo markClassName="h-7 w-7" textClassName="text-sm" />
            <span className="text-sm text-slate-400">No lead left behind</span>
          </div>

          <nav
            aria-label="Footer"
            className="flex flex-wrap items-center justify-center gap-6 text-sm text-slate-500"
          >
            {NAV.map((item) => (
              <Link key={item.to} to={item.to} className="transition hover:text-slate-900">
                {item.label}
              </Link>
            ))}
            <Link to="/login" className="transition hover:text-slate-900">
              Sign in
            </Link>
          </nav>
        </div>

        <div className="mt-8 border-t border-slate-100 pt-6 text-center md:text-left">
          <Copyright />
        </div>
      </div>
    </footer>
  );
}

/** Shared section heading, so the public pages stay typographically consistent. */
export function SectionHeading({
  title,
  subtitle,
  centered = false,
}: {
  title: string;
  subtitle?: string;
  centered?: boolean;
}): React.JSX.Element {
  return (
    <div className={centered ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      <h2 className="text-2xl font-semibold tracking-tight text-balance text-slate-900 sm:text-3xl">
        {title}
      </h2>
      {subtitle && <p className="mt-3 text-pretty text-slate-600">{subtitle}</p>}
    </div>
  );
}
