import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MembershipSummary } from '@leadflow/api-types';
import { apiGet } from '../lib/api-client';
import { humanise } from '../lib/format';
import { useAuth } from '../features/auth/auth-context';

/**
 * Organization switcher.
 *
 * Hidden entirely for the common case of a single membership — a control that
 * can only ever do nothing is noise.
 *
 * Switching invalidates the whole query cache. Every cached list belongs to the
 * previous tenant, and showing one organization's leads under another's name,
 * even for a frame, is exactly the failure the tenant work exists to prevent.
 */
export function OrganizationSwitcher(): React.JSX.Element | null {
  const { user, switchOrganization } = useAuth();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);

  const memberships = useQuery({
    queryKey: ['my-organizations'],
    queryFn: () => apiGet<MembershipSummary[]>('/auth/organizations'),
  });

  // Close on Escape and on outside click — expected of any menu.
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onClick = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };

    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    firstItem.current?.focus();

    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const organizations = memberships.data ?? [];
  if (organizations.length <= 1) return null;

  const select = async (organizationId: string): Promise<void> => {
    if (organizationId === user?.organization.id) {
      setOpen(false);
      return;
    }

    setError(null);
    setSwitching(organizationId);

    try {
      await switchOrganization(organizationId);
      await queryClient.invalidateQueries();
      setOpen(false);
    } catch {
      setError('Could not switch organization.');
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-[11px] font-bold text-white">
          {user?.organization.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-900">
            {user?.organization.name}
          </span>
          <span className="block truncate text-[11px] text-slate-500">
            {organizations.length} organizations
          </span>
        </span>
        <span aria-hidden className="text-xs text-slate-400">
          ⌄
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Switch organization"
          className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg"
        >
          {organizations.map((organization, index) => (
            <button
              key={organization.id}
              ref={index === 0 ? firstItem : undefined}
              type="button"
              role="menuitem"
              disabled={switching !== null}
              onClick={() => void select(organization.id)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-900">{organization.name}</span>
                <span className="block text-[11px] text-slate-500">
                  {humanise(organization.role)}
                </span>
              </span>
              {switching === organization.id ? (
                <span className="text-[11px] text-slate-400">Switching…</span>
              ) : organization.current ? (
                <span aria-label="Current organization" className="text-xs text-emerald-600">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-1 px-2 text-[11px] text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
