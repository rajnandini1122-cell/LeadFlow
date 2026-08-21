import type { ReactNode } from 'react';
import type { LeadPriority, LeadStatus } from '@leadflow/api-types';
import { humanise, initials } from '../lib/format';

/**
 * Small design system.
 *
 * Colour is used to carry meaning, not decoration: pipeline stage progresses
 * cool → warm → resolved, and anything overdue is red. A salesperson should be
 * able to read the screen at a glance without reading the words.
 */

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  action,
  subtitle,
}: {
  title: string;
  subtitle?: string | undefined;
  action?: ReactNode | undefined;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string | undefined;
  action?: ReactNode | undefined;
}): React.JSX.Element {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Status and priority
// -----------------------------------------------------------------------------

/** Cool early stages, warm mid-pipeline, green won, rose lost. */
const STATUS_STYLES: Record<LeadStatus, string> = {
  NEW: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  CONTACTED: 'bg-cyan-50 text-cyan-700 ring-cyan-600/20',
  QUALIFIED: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  FOLLOW_UP: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  QUOTATION_SENT: 'bg-orange-50 text-orange-700 ring-orange-600/20',
  NEGOTIATION: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-600/20',
  WON: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  LOST: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};

export function StatusBadge({ status }: { status: LeadStatus }): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLES[status]}`}
    >
      {humanise(status)}
    </span>
  );
}

const PRIORITY_STYLES: Record<LeadPriority, { dot: string; text: string }> = {
  URGENT: { dot: 'bg-red-500', text: 'text-red-700' },
  HIGH: { dot: 'bg-orange-500', text: 'text-orange-700' },
  MEDIUM: { dot: 'bg-blue-500', text: 'text-blue-700' },
  LOW: { dot: 'bg-slate-400', text: 'text-slate-500' },
};

export function PriorityBadge({ priority }: { priority: LeadPriority }): React.JSX.Element {
  const style = PRIORITY_STYLES[priority];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${style.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
      {humanise(priority)}
    </span>
  );
}

/**
 * The product's core signal: how late is this follow-up?
 *
 * Overdue is loud on purpose — "no lead left behind" only works if a missed
 * follow-up is impossible to scroll past.
 */
export function DueBadge({ iso, label }: { iso: string | null; label: string }): React.JSX.Element {
  if (!iso) return <span className="text-xs text-slate-400">{label}</span>;

  const days = Math.round(
    (new Date(new Date(iso).toDateString()).getTime() -
      new Date(new Date().toDateString()).getTime()) /
      86_400_000,
  );

  const tone =
    days < 0
      ? 'bg-red-50 text-red-700 ring-red-600/20'
      : days === 0
        ? 'bg-amber-50 text-amber-800 ring-amber-600/20'
        : 'bg-slate-50 text-slate-600 ring-slate-500/15';

  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {label}
    </span>
  );
}

export function RoleBadge({ role }: { role: string }): React.JSX.Element {
  const tone =
    role === 'OWNER'
      ? 'bg-indigo-50 text-indigo-700 ring-indigo-600/20'
      : role === 'ADMIN'
        ? 'bg-purple-50 text-purple-700 ring-purple-600/20'
        : role === 'MANAGER'
          ? 'bg-blue-50 text-blue-700 ring-blue-600/20'
          : 'bg-slate-100 text-slate-600 ring-slate-500/20';

  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {humanise(role)}
    </span>
  );
}

// -----------------------------------------------------------------------------

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }): React.JSX.Element {
  const dimensions = size === 'sm' ? 'h-7 w-7 text-[11px]' : 'h-9 w-9 text-xs';

  // Deterministic tint from the name, so a person keeps the same colour
  // everywhere in the app rather than flickering between renders.
  const palette = [
    'bg-indigo-100 text-indigo-700',
    'bg-emerald-100 text-emerald-700',
    'bg-amber-100 text-amber-800',
    'bg-rose-100 text-rose-700',
    'bg-sky-100 text-sky-700',
    'bg-violet-100 text-violet-700',
  ];
  const hash = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0);

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${dimensions} ${palette[hash % palette.length]}`}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'danger' | 'warning' | 'success';
}): React.JSX.Element {
  const valueTone = {
    default: 'text-slate-900',
    danger: 'text-red-600',
    warning: 'text-amber-600',
    success: 'text-emerald-600',
  }[tone];

  const accent = {
    default: 'before:bg-slate-200',
    danger: 'before:bg-red-500',
    warning: 'before:bg-amber-500',
    success: 'before:bg-emerald-500',
  }[tone];

  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] before:absolute before:inset-y-0 before:left-0 before:w-1 ${accent}`}
    >
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${valueTone}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon = '○',
}: {
  title: string;
  description: string;
  icon?: string;
}): React.JSX.Element {
  return (
    <div className="px-6 py-14 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-lg text-slate-400">
        {icon}
      </div>
      <p className="mt-3 text-sm font-medium text-slate-900">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">{description}</p>
    </div>
  );
}

/** Shape-matched placeholder, so the layout does not jump when data lands. */
export function SkeletonRows({ rows = 5 }: { rows?: number }): React.JSX.Element {
  return (
    <div className="divide-y divide-slate-100">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-5 py-3.5">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-slate-100" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/3 animate-pulse rounded bg-slate-100" />
            <div className="h-2.5 w-1/4 animate-pulse rounded bg-slate-50" />
          </div>
          <div className="h-5 w-20 animate-pulse rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

export function ErrorNotice({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="px-5 py-8 text-center">
      <p className="text-sm font-medium text-red-700">Could not load this</p>
      <p className="mt-1 text-sm text-slate-500">{message}</p>
    </div>
  );
}

export function PhaseNote({ phase, children }: { phase: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-4 py-3">
      <span className="mt-px shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-800 uppercase">
        {phase}
      </span>
      <p className="text-xs leading-relaxed text-slate-600">{children}</p>
    </div>
  );
}
