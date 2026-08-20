import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrganizationDetail } from '@leadflow/api-types';
import { ApiError, apiGet, apiPatch } from '../../lib/api-client';
import { formatDate } from '../../lib/format';
import {
  Card,
  CardHeader,
  ErrorNotice,
  PageHeader,
  PhaseNote,
  SkeletonRows,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';

/**
 * Organization settings — a real, working editor, not a placeholder.
 *
 * The follow-up escalation thresholds here are the same values the Phase 6
 * worker will read. They live in `organization_settings` rather than in code
 * precisely so they can be tuned per tenant without a deploy (spec §10).
 */
export function SettingsPage(): React.JSX.Element {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = can('org.update');

  const organization = useQuery({
    queryKey: ['organization'],
    queryFn: () => apiGet<OrganizationDetail>('/organizations/current'),
  });

  const [name, setName] = useState('');
  const [reminder, setReminder] = useState(30);
  const [overdue, setOverdue] = useState(120);
  const [escalate, setEscalate] = useState(false);
  const [start, setStart] = useState('09:30');
  const [end, setEnd] = useState('18:30');
  const [saved, setSaved] = useState(false);

  // Seed the form once the organization loads. Without this the inputs stay
  // empty and a save would blank the record.
  useEffect(() => {
    const data = organization.data;
    if (!data) return;
    setName(data.name);
    setReminder(data.settings.followupReminderMinutes);
    setOverdue(data.settings.followupOverdueMinutes);
    setEscalate(data.settings.escalateToManager);
    setStart(data.settings.workingHoursStart);
    setEnd(data.settings.workingHoursEnd);
  }, [organization.data]);

  const save = useMutation({
    mutationFn: () =>
      apiPatch<OrganizationDetail>('/organizations/current', {
        name,
        settings: {
          followupReminderMinutes: reminder,
          followupOverdueMinutes: overdue,
          escalateToManager: escalate,
          workingHoursStart: start,
          workingHoursEnd: end,
        },
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['organization'], updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  if (organization.isPending) {
    return (
      <>
        <PageHeader title="Settings" />
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      </>
    );
  }

  if (organization.isError) {
    return (
      <Card>
        <ErrorNotice message="Could not load organization settings." />
      </Card>
    );
  }

  const data = organization.data;

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle={canEdit ? 'Organization profile and follow-up rules' : 'Read-only — your role cannot change these'}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Organization" />
            <div className="space-y-4 p-5">
              <Field label="Name" htmlFor="org-name">
                <input
                  id="org-name"
                  value={name}
                  disabled={!canEdit}
                  onChange={(event) => setName(event.target.value)}
                  className={inputClass}
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Slug" htmlFor="org-slug" hint="Cannot be changed">
                  <input id="org-slug" value={data.slug} disabled className={inputClass} />
                </Field>
                <Field label="Currency" htmlFor="org-currency" hint="INR only in the MVP">
                  <input id="org-currency" value={data.currency} disabled className={inputClass} />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Timezone" htmlFor="org-tz" hint="Used to compute “today”">
                  <input id="org-tz" value={data.timezone} disabled className={inputClass} />
                </Field>
                <Field label="Created" htmlFor="org-created">
                  <input
                    id="org-created"
                    value={formatDate(data.createdAt)}
                    disabled
                    className={inputClass}
                  />
                </Field>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Follow-up rules"
              subtitle="Read by the follow-up worker in Phase 6"
            />
            <div className="space-y-4 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Reminder after"
                  htmlFor="reminder"
                  hint="Minutes after a follow-up becomes due"
                >
                  <input
                    id="reminder"
                    type="number"
                    min={1}
                    value={reminder}
                    disabled={!canEdit}
                    onChange={(event) => setReminder(Number(event.target.value))}
                    className={inputClass}
                  />
                </Field>
                <Field
                  label="Mark overdue after"
                  htmlFor="overdue"
                  hint="Minutes before it counts as overdue"
                >
                  <input
                    id="overdue"
                    type="number"
                    min={1}
                    value={overdue}
                    disabled={!canEdit}
                    onChange={(event) => setOverdue(Number(event.target.value))}
                    className={inputClass}
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Working hours start" htmlFor="start">
                  <input
                    id="start"
                    type="time"
                    value={start}
                    disabled={!canEdit}
                    onChange={(event) => setStart(event.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Working hours end" htmlFor="end">
                  <input
                    id="end"
                    type="time"
                    value={end}
                    disabled={!canEdit}
                    onChange={(event) => setEnd(event.target.value)}
                    className={inputClass}
                  />
                </Field>
              </div>

              <label className="flex items-start gap-3 rounded-lg bg-slate-50 px-4 py-3">
                <input
                  type="checkbox"
                  checked={escalate}
                  disabled={!canEdit}
                  onChange={(event) => setEscalate(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-900">
                    Escalate to manager
                  </span>
                  <span className="block text-xs text-slate-500">
                    Notify the assigned rep&rsquo;s manager when a follow-up passes the
                    overdue threshold.
                  </span>
                </span>
              </label>
            </div>

            {canEdit && (
              <div className="flex items-center justify-end gap-3 border-t border-slate-100 px-5 py-3">
                {save.isError && (
                  <span className="text-xs text-red-600">
                    {save.error instanceof ApiError ? save.error.message : 'Could not save'}
                  </span>
                )}
                {saved && <span className="text-xs text-emerald-600">Saved</span>}
                <button
                  type="button"
                  onClick={() => save.mutate()}
                  disabled={save.isPending}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
                >
                  {save.isPending ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Your access" />
            <div className="p-5">
              <PermissionList />
            </div>
          </Card>

          <PhaseNote phase="Phase 6">
            Saving these values works today and they persist to
            <code className="mx-1 rounded bg-slate-200 px-1 text-[11px]">organization_settings</code>
            — the follow-up worker reads them from there rather than from
            hardcoded constants, so escalation can differ per tenant.
          </PhaseNote>
        </div>
      </div>
    </>
  );
}

function PermissionList(): React.JSX.Element {
  const { user } = useAuth();
  if (!user) return <p className="text-sm text-slate-500">—</p>;

  return (
    <>
      <p className="text-xs text-slate-500">Role</p>
      <p className="mt-0.5 text-sm font-medium text-slate-900">{user.role}</p>

      <p className="mt-4 text-xs text-slate-500">
        {user.permissions.length} permissions granted
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {user.permissions.map((permission) => (
          <span
            key={permission}
            className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
          >
            {permission}
          </span>
        ))}
      </div>
    </>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-500';

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
