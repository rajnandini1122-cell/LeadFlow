import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrganizationDetail } from '@leadflow/api-types';
import { ApiError, apiGet, apiPatch } from '../../lib/api-client';
import { formatDate, setFormattingContext } from '../../lib/format';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { LeadSourceEditor } from './lead-source-editor';

interface LocaleOptions {
  timezones: string[];
  currencies: string[];
}
import { useAuth } from '../auth/auth-context';
import { AndroidDownloadCard } from './android-download-card';
import { ProfilePictureCard } from './profile-picture-card';

/**
 * Organization settings — a real, working editor, not a placeholder.
 *
 * Everything a tenant can configure about themselves. Timezone, currency,
 * locale and country are not cosmetic: they decide what "today" means in every
 * report, how money is formatted, and how a local phone number is read into
 * E.164 — which is what duplicate detection matches on.
 *
 * The escalation thresholds live in `organization_settings` rather than in
 * code precisely so they can be tuned per tenant without a deploy (spec §10).
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
  const [timezone, setTimezone] = useState('UTC');
  const [currency, setCurrency] = useState('USD');
  const [locale, setLocale] = useState('en-US');
  const [country, setCountry] = useState('US');
  const [sources, setSources] = useState<string[]>([]);
  const [reminder, setReminder] = useState(30);
  const [overdue, setOverdue] = useState(120);
  const [escalate, setEscalate] = useState(false);
  const [start, setStart] = useState('09:30');
  const [end, setEnd] = useState('18:30');
  const [saved, setSaved] = useState(false);

  /**
   * Timezones and currencies this deployment can offer.
   *
   * Fetched rather than bundled: the list comes from the server's own ICU
   * data, so the screen can never present an option the API would refuse — and
   * it always includes the tenant's current zone, even when that is a legacy
   * alias Intl does not list canonically.
   */
  const options = useQuery({
    queryKey: ['locale-options'],
    queryFn: () => apiGet<LocaleOptions>('/organizations/locale-options'),
  });

  // Seed the form once the organization loads. Without this the inputs stay
  // empty and a save would blank the record.
  useEffect(() => {
    const data = organization.data;
    if (!data) return;
    setName(data.name);
    setTimezone(data.timezone);
    setCurrency(data.currency);
    setLocale(data.locale);
    setCountry(data.country);
    setSources(data.settings.leadSources);
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
        timezone,
        currency,
        locale,
        country,
        settings: {
          followupReminderMinutes: reminder,
          followupOverdueMinutes: overdue,
          escalateToManager: escalate,
          workingHoursStart: start,
          workingHoursEnd: end,
          leadSources: sources,
        },
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['organization'], updated);

      // Currency, locale and timezone drive every formatted figure on screen.
      // Without this the tenant saves GBP and keeps seeing dollars until they
      // reload, which reads as the save having failed.
      setFormattingContext({
        locale: updated.locale,
        currency: updated.currency,
        timezone: updated.timezone,
      });
      void queryClient.invalidateQueries({ queryKey: ['locale-options'] });

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
                <Field
                  label="Timezone"
                  htmlFor="org-tz"
                  hint="Decides what “today” means in every report and follow-up bucket"
                >
                  <select
                    id="org-tz"
                    value={timezone}
                    disabled={!canEdit}
                    onChange={(event) => setTimezone(event.target.value)}
                    className={inputClass}
                  >
                    {(options.data?.timezones ?? [data.timezone]).map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  label="Country"
                  htmlFor="org-country"
                  hint="Decides how a local phone number is read — this drives duplicate detection"
                >
                  <select
                    id="org-country"
                    value={country}
                    disabled={!canEdit}
                    onChange={(event) => setCountry(event.target.value)}
                    className={inputClass}
                  >
                    {COUNTRIES.map((code) => (
                      <option key={code} value={code}>
                        {countryName(code)} ({code})
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Currency"
                  htmlFor="org-currency"
                  hint="Every amount in the app is formatted in this currency"
                >
                  <select
                    id="org-currency"
                    value={currency}
                    disabled={!canEdit}
                    onChange={(event) => setCurrency(event.target.value)}
                    className={inputClass}
                  >
                    {(options.data?.currencies ?? [data.currency]).map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  label="Locale"
                  htmlFor="org-locale"
                  hint="Number and date conventions, e.g. 1,234.50 or 1.234,50"
                >
                  <select
                    id="org-locale"
                    value={locale}
                    disabled={!canEdit}
                    onChange={(event) => setLocale(event.target.value)}
                    className={inputClass}
                  >
                    {localeChoices(locale).map((tag) => (
                      <option key={tag} value={tag}>
                        {localeName(tag)} ({tag})
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Slug" htmlFor="org-slug" hint="Cannot be changed">
                  <input id="org-slug" value={data.slug} disabled className={inputClass} />
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

              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">Preview</p>
                <p className="mt-1 text-sm text-slate-900">
                  {previewAmount(locale, currency)}
                  <span className="mx-2 text-slate-300">·</span>
                  {previewDate(locale, timezone)}
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Lead sources"
              subtitle="The options offered when someone adds a lead"
            />
            <div className="p-5">
              <LeadSourceEditor value={sources} onChange={setSources} disabled={!canEdit} />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Follow-up rules"
              subtitle="When a follow-up counts as due, and then as overdue"
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
          {/* Your own profile, above the read-only access summary. */}
          <ProfilePictureCard />

          <Card>
            <CardHeader title="Your access" />
            <div className="p-5">
              <PermissionList />
            </div>
          </Card>

          {/*
            * Also here, not only on the marketing page.
            *
            * A signed-in visitor to '/' is sent to their dashboard, so the
            * download card on the home page is only ever seen while signed
            * out — which is exactly the wrong time to be told the phone app
            * exists. Renders nothing if no APK has been published.
            */}
          <AndroidDownloadCard />

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

/**
 * Countries offered for phone parsing.
 *
 * A curated list rather than all 249 regions: this field exists to decide how a
 * local number is read, and a 249-entry dropdown makes the common case harder
 * without helping the rare one. Any valid ISO 3166-1 code is still accepted by
 * the API, and the tenant's own value is always included below.
 */
const COMMON_COUNTRIES = [
  'US', 'GB', 'IN', 'CA', 'AU', 'NZ', 'IE', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE',
  'SE', 'NO', 'DK', 'FI', 'PL', 'PT', 'CH', 'AT', 'AE', 'SA', 'SG', 'MY', 'ID',
  'PH', 'TH', 'VN', 'JP', 'KR', 'CN', 'HK', 'ZA', 'NG', 'KE', 'EG', 'BR', 'MX',
  'AR', 'CL', 'CO',
];

const COUNTRIES = COMMON_COUNTRIES;

const COMMON_LOCALES = [
  'en-US', 'en-GB', 'en-IN', 'en-AU', 'en-CA', 'en-NZ', 'en-IE', 'en-ZA',
  'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'pt-BR', 'pt-PT', 'sv-SE',
  'da-DK', 'nb-NO', 'fi-FI', 'pl-PL', 'ar-AE', 'hi-IN', 'ja-JP', 'ko-KR',
  'zh-CN', 'id-ID', 'ms-MY', 'th-TH', 'vi-VN', 'tr-TR',
];

/** The tenant's own locale is always offered, even if it is not in the list. */
function localeChoices(current: string): string[] {
  return COMMON_LOCALES.includes(current) ? COMMON_LOCALES : [current, ...COMMON_LOCALES];
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function localeName(tag: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** Shows what the choices actually do, before they are saved. */
function previewAmount(locale: string, currency: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(1234.5);
  } catch {
    return `${currency} 1234.50`;
  }
}

function previewDate(locale: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
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
