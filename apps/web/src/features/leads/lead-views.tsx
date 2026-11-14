import { useState } from 'react';

/**
 * Saved views for the Leads workspace.
 *
 * A view is nothing but URL filter state, so a view never grants access to
 * anything: the server applies the person's visibility to whatever it asks
 * for. Built-in views are fixed; custom views are this person's own, kept in
 * this browser (no new server table).
 */
export interface LeadView {
  id: string;
  name: string;
  params: Record<string, string>;
  builtIn?: boolean;
}

const KEY = (userId: string) => `leadflow.leadViews.${userId}`;

export function builtInViews(userId: string | undefined, canSeeTeam: boolean): LeadView[] {
  return [
    { id: 'all', name: 'All leads', params: {}, builtIn: true },
    ...(userId ? [{ id: 'mine', name: 'My leads', params: { owner: userId }, builtIn: true }] : []),
    { id: 'overdue', name: 'Overdue', params: { overdue: 'true' }, builtIn: true },
    ...(canSeeTeam
      ? [{ id: 'unassigned', name: 'Unassigned', params: { unassigned: 'true' }, builtIn: true }]
      : []),
  ];
}

export function loadCustomViews(userId: string | undefined): LeadView[] {
  if (!userId) return [];
  try {
    const raw = window.localStorage.getItem(KEY(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (v): v is LeadView =>
            typeof v?.id === 'string' &&
            typeof v?.name === 'string' &&
            typeof v?.params === 'object',
        )
      : [];
  } catch {
    return [];
  }
}

function saveCustomViews(userId: string, views: LeadView[]): void {
  try {
    window.localStorage.setItem(KEY(userId), JSON.stringify(views));
  } catch {
    // Storage blocked (private window): the view simply is not remembered.
  }
}

/** Filter keys that make up a view (everything except paging and layout). */
const VIEW_KEYS = [
  'status',
  'owner',
  'overdue',
  'unassigned',
  'fresh',
  'awaiting',
  'qualification',
  'lastOutcome',
  'market',
  'q',
];

export function viewParams(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of VIEW_KEYS) {
    const value = params.get(key);
    if (value) out[key] = value;
  }
  return out;
}

export function sameView(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export function ViewTabs({
  userId,
  canSeeTeam,
  current,
  onSelect,
}: {
  userId: string | undefined;
  canSeeTeam: boolean;
  current: Record<string, string>;
  onSelect: (params: Record<string, string>) => void;
}): React.JSX.Element {
  const [custom, setCustom] = useState<LeadView[]>(() => loadCustomViews(userId));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const views = [...builtInViews(userId, canSeeTeam), ...custom];
  const active = views.find((v) => sameView(v.params, current));

  const save = () => {
    if (!userId || !name.trim()) return;
    const next = [
      ...custom,
      { id: crypto.randomUUID(), name: name.trim().slice(0, 40), params: current },
    ];
    setCustom(next);
    saveCustomViews(userId, next);
    setNaming(false);
    setName('');
  };
  const remove = (id: string) => {
    if (!userId) return;
    const next = custom.filter((v) => v.id !== id);
    setCustom(next);
    saveCustomViews(userId, next);
  };

  return (
    <nav aria-label="Saved views" className="flex flex-wrap items-center gap-1.5">
      {views.map((view) => (
        <span key={view.id} className="inline-flex items-center">
          <button
            type="button"
            aria-pressed={active?.id === view.id}
            onClick={() => onSelect(view.params)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
              active?.id === view.id
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {view.name}
          </button>
          {!view.builtIn && (
            <button
              type="button"
              onClick={() => remove(view.id)}
              aria-label={`Delete view ${view.name}`}
              className="ml-0.5 rounded-full px-1.5 text-xs text-slate-400 hover:text-red-600"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!active && Object.keys(current).length > 0 && !naming && (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="rounded-full px-3 py-1.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200 hover:bg-sky-50"
        >
          + Save this view
        </button>
      )}
      {naming && (
        <form
          className="inline-flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="View name"
            aria-label="View name"
            maxLength={40}
            className="w-36 rounded-full border border-slate-300 px-3 py-1 text-xs"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-full bg-slate-900 px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setNaming(false)}
            className="px-1 text-xs text-slate-500"
          >
            Cancel
          </button>
        </form>
      )}
    </nav>
  );
}
