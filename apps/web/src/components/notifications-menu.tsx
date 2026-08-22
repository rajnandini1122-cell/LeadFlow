import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';

/**
 * What needs attention, in one place.
 *
 * Deliberately an AGGREGATOR, not a notification system. There is no
 * notifications table, no delivery, no read state and no push — building those
 * is a real feature with real storage behind it, and pretending otherwise would
 * mean inventing a feed. Everything here is a live count the app already
 * fetches for its nav badges, gathered behind one bell so nothing has to be
 * noticed by scanning the sidebar.
 *
 * The consequence, stated plainly: the LIST reflects what is true right now. It
 * cannot tell you what happened while you were away, and an item stops being
 * listed when it stops being outstanding — not when somebody looks at it.
 *
 * The BADGE is the one thing that remembers: opening the menu records the
 * current counts locally, so it stops nagging about work you have already
 * seen, and returns if a count rises. That is a per-device convenience, not
 * server-side read state.
 */

export interface AttentionItem {
  /** Stable key, also used as the test hook. */
  id: string;
  /** How many things. Zero-count items are never rendered. */
  count: number;
  label: string;
  /** What to do about it. */
  to: string;
  /** Overdue work reads differently from a queue that is merely non-empty. */
  tone: 'urgent' | 'normal';
}

/**
 * What the viewer has already looked at.
 *
 * A count per item, from the last time the menu was opened. Kept in
 * localStorage because it is a per-person, per-device convenience — there is
 * no server-side read state, and inventing one would mean a notifications
 * table, delivery and a sync story for something that is a badge.
 */
const SEEN_KEY = 'leadflow.attention.seen';

function readSeen(): Record<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    // Private window, cleared storage, or storage disabled. An empty record
    // means "nothing seen", so the badge shows — which errs towards showing
    // work rather than hiding it.
    return {};
  }
}

function writeSeen(counts: Record<string, number>): void {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify(counts));
  } catch {
    // Not fatal: the badge simply keeps showing.
  }
}

export function NotificationsMenu({ items }: { items: AttentionItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Record<string, number>>(() => readSeen());
  const container = useRef<HTMLDivElement>(null);

  // Only things that actually need attention. A "0 overdue" row is noise that
  // trains people to ignore the bell.
  const active = items.filter((item) => item.count > 0);

  /*
   * The BADGE counts what is new; the LIST always shows everything current.
   *
   * Those are deliberately different questions. A badge that never clears is
   * ignored within a day, but hiding outstanding work because somebody glanced
   * at it once would be worse — so opening the menu stops the badge nagging
   * and changes nothing about what the menu contains. If a count then RISES,
   * the badge returns for the difference.
   */
  const unseen = active.reduce(
    (sum, item) => sum + Math.max(0, item.count - (seen[item.id] ?? 0)),
    0,
  );
  const total = unseen;
  const urgent = active.some(
    (item) => item.tone === 'urgent' && item.count > (seen[item.id] ?? 0),
  );

  /** Records what is on screen now, so the badge stops counting it. */
  const markSeen = (): void => {
    const snapshot: Record<string, number> = {};
    for (const item of items) snapshot[item.id] = item.count;
    writeSeen(snapshot);
    setSeen(snapshot);
  };

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          // Opening it counts as having looked.
          if (next) markSeen();
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          total === 0
            ? 'Notifications: nothing needs attention'
            : `Notifications: ${total} item${total === 1 ? '' : 's'} need attention`
        }
        className="relative rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
      >
        <span aria-hidden="true" className="text-base">
          🔔
        </span>
        {total > 0 && (
          <span
            aria-hidden="true"
            className={`absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white ${
              urgent ? 'bg-red-500' : 'bg-slate-700'
            }`}
          >
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-72 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
        >
          <p className="border-b border-slate-100 px-4 py-2.5 text-xs font-medium text-slate-500">
            Needs attention
          </p>

          {active.length === 0 ? (
            <p className="px-4 py-4 text-sm text-slate-500">
              Nothing needs attention right now.
            </p>
          ) : (
            <ul>
              {active.map((item) => (
                <li key={item.id}>
                  <NavLink
                    to={item.to}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition hover:bg-slate-50"
                  >
                    <span className="text-slate-700">{item.label}</span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                        item.tone === 'urgent'
                          ? 'bg-red-50 text-red-700'
                          : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {item.count}
                    </span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}

          {/*
            * Honest about what this is. Somebody who expects a message history
            * should know they are looking at live counts, not a feed.
            */}
          <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
            Live counts, not a message history. The badge clears once you have looked; the
            list always shows what is outstanding.
          </p>
        </div>
      )}
    </div>
  );
}
