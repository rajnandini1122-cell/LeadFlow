import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  EMAIL_CAMPAIGN_CATEGORIES,
  EMAIL_MERGE_FIELDS,
  LEAD_PRIORITIES,
  LEAD_STATUSES,
  MAX_CUSTOM_EMAILS,
  PERMISSIONS,
  type EmailAudiencePreview,
  type EmailCampaignCategory,
  type EmailCampaignPurpose,
  type EmailRecipientFilter,
} from '@leadflow/api-types';
import { useAuth } from '../auth/auth-context';
import { ApiError } from '../../lib/api-client';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import {
  CATEGORY_LABELS,
  useAssets,
  useAudienceOptions,
  useAudiencePreview,
  useCampaign,
  useCampaignAction,
  useMailbox,
  useRenderedPreview,
  useSaveCampaign,
  useTemplates,
  useTestSend,
  useUploadAsset,
  type CampaignInput,
} from './use-email';
import { sendingReadiness } from './sending-readiness';

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:ring-1 focus:ring-slate-900 focus:outline-none';

const EXCLUSION_LABELS: Record<string, string> = {
  NO_CONSENT: 'no recorded marketing eligibility',
  SUPPRESSED: 'unsubscribed, bounced or suppressed',
  INVALID: 'no valid email address',
  DUPLICATE: 'same address reached twice',
  EXCLUDED: 'taken out by hand in the list below',
};

const EMPTY: CampaignInput = {
  name: '',
  category: 'PROMOTIONAL_OFFER',
  purpose: 'PROMOTIONAL',
  subject: '',
  html: '<p>Dear {{first_name}},</p><p></p><p>Regards,<br>{{sender_name}}</p>',
  text: '',
  assetIds: [],
  filter: {},
};

/** Comma-separated text <-> list, for the free-text filters. */
const toList = (value: string) =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

export function CampaignEditorPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const existing = useCampaign(id);
  const save = useSaveCampaign();
  const templates = useTemplates();
  const [form, setForm] = useState<CampaignInput>(EMPTY);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  // Every hook runs before the loading return below: a hook after it changes
  // the hook count between renders and React blanks the page.
  const options = useAudienceOptions();

  useEffect(() => {
    if (existing.data && loadedId !== existing.data.id) {
      const c = existing.data;
      setForm({
        name: c.name,
        category: c.category,
        purpose: c.purpose,
        subject: c.subject,
        html: c.html,
        text: c.text,
        assetIds: c.assetIds,
        filter: c.filter,
      });
      setLoadedId(c.id);
    }
  }, [existing.data, loadedId]);

  if (existing.data && existing.data.status !== 'DRAFT') {
    navigate(`/campaigns/${existing.data.id}`, { replace: true });
  }
  if (id && existing.isLoading) return <SkeletonRows rows={8} />;

  const set = <K extends keyof CampaignInput>(key: K, value: CampaignInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setFilter = (patch: Partial<EmailRecipientFilter>) =>
    setForm((f) => ({ ...f, filter: { ...f.filter, ...patch } }));
  const isCustom = form.filter.source === 'CUSTOM';

  const submit = () =>
    save.mutate(
      { ...(id ? { id } : {}), input: form },
      { onSuccess: (view) => !id && navigate(`/campaigns/${view.id}/edit`, { replace: true }) },
    );

  return (
    <>
      <PageHeader
        title={id ? form.name || 'Campaign' : 'New campaign'}
        subtitle={
          <Link to="/campaigns" className="hover:underline">
            ← All campaigns
          </Link>
        }
        action={
          <button
            type="button"
            onClick={submit}
            disabled={save.isPending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : id ? 'Save draft' : 'Create draft'}
          </button>
        }
      />
      {save.error && (
        <ErrorNotice
          message={save.error instanceof ApiError ? save.error.message : 'Could not save.'}
        />
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Campaign" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="Name" id="name">
                <input
                  id="name"
                  className={inputClass}
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  maxLength={150}
                />
              </Field>
              <Field label="Type" id="category">
                <select
                  id="category"
                  className={inputClass}
                  value={form.category}
                  onChange={(e) => set('category', e.target.value as EmailCampaignCategory)}
                >
                  {EMAIL_CAMPAIGN_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Kind of message"
                id="purpose"
                hint={
                  form.purpose === 'PROMOTIONAL'
                    ? 'Only to people with recorded marketing eligibility. Includes an unsubscribe link.'
                    : 'Service information for existing customers only — not offers.'
                }
              >
                <select
                  id="purpose"
                  className={inputClass}
                  value={form.purpose}
                  onChange={(e) => set('purpose', e.target.value as EmailCampaignPurpose)}
                >
                  <option value="PROMOTIONAL">Promotional (marketing)</option>
                  <option value="TRANSACTIONAL">Service message (not marketing)</option>
                </select>
              </Field>
              <Field label="Start from a template" id="template">
                <select
                  id="template"
                  className={inputClass}
                  value=""
                  onChange={(e) => {
                    const t = templates.data?.find((x) => x.id === e.target.value);
                    if (t)
                      setForm((f) => ({
                        ...f,
                        templateId: t.id,
                        category: t.category,
                        subject: t.subject,
                        html: t.html,
                        text: t.text,
                      }));
                  }}
                >
                  <option value="">Choose…</option>
                  {templates.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Message"
              subtitle="HTML is cleaned on the server: no scripts, no forms, https images only."
            />
            <div className="space-y-4 p-5">
              <Field label="Subject" id="subject">
                <input
                  id="subject"
                  className={inputClass}
                  value={form.subject}
                  onChange={(e) => set('subject', e.target.value)}
                  maxLength={200}
                />
              </Field>
              <RichTextEditor value={form.html} onChange={(html) => set('html', html)} />
              <Field
                label="Plain-text version"
                id="text"
                hint="Optional. Generated from the message when left empty."
              >
                <textarea
                  id="text"
                  rows={5}
                  className={inputClass}
                  value={form.text ?? ''}
                  onChange={(e) => set('text', e.target.value)}
                />
              </Field>
              <AttachmentPicker
                selected={form.assetIds}
                onChange={(assetIds) => set('assetIds', assetIds)}
              />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Campaign recipients"
              subtitle={
                isCustom
                  ? 'Exactly the addresses you enter. The same eligibility and unsubscribe rules apply.'
                  : 'Leads with an email address. Filters combine (all must match).'
              }
            />
            <p className="px-5 pt-3 text-xs text-slate-500">
              They receive the campaign only after “Review and send…”. Test emails never go to them
              — a test goes only to the address on the test button you click.
            </p>
            <fieldset className="flex flex-wrap gap-4 px-5 pt-4 text-sm">
              <legend className="sr-only">Who receives it</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="recipient-source"
                  checked={!isCustom}
                  onChange={() => setFilter({ source: 'LEADS' })}
                />
                Leads matching filters
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="recipient-source"
                  checked={isCustom}
                  onChange={() => setFilter({ source: 'CUSTOM' })}
                />
                A custom list of email addresses
              </label>
            </fieldset>
            {isCustom ? (
              <CustomEmailList
                value={form.filter.customEmails ?? []}
                onChange={(customEmails) => setFilter({ customEmails })}
              />
            ) : (
              <div className="grid gap-4 p-5 sm:grid-cols-2">
                <MultiCheck
                  label="Lead status"
                  options={LEAD_STATUSES as readonly string[]}
                  value={form.filter.statuses ?? []}
                  onChange={(statuses) => setFilter({ statuses })}
                />
                <MultiCheck
                  label="Priority"
                  options={LEAD_PRIORITIES as readonly string[]}
                  value={form.filter.priorities ?? []}
                  onChange={(priorities) => setFilter({ priorities })}
                />
                <MultiCheck
                  label="Contact history"
                  options={['NEVER', 'CONTACTED']}
                  labels={{
                    NEVER: `Not contacted yet${options.data ? ` (${options.data.contacted.never})` : ''}`,
                    CONTACTED: `Contacted before${options.data ? ` (${options.data.contacted.contacted})` : ''}`,
                  }}
                  value={form.filter.contacted ?? []}
                  onChange={(contacted) =>
                    setFilter({ contacted: contacted as ('NEVER' | 'CONTACTED')[] })
                  }
                />
                <CityChecklist
                  cities={options.data?.cities ?? []}
                  value={form.filter.cities ?? []}
                  onChange={(cities) => setFilter({ cities })}
                />
                <Field label="States" id="states" hint="Comma-separated">
                  <input
                    id="states"
                    className={inputClass}
                    defaultValue={(form.filter.states ?? []).join(', ')}
                    onBlur={(e) => setFilter({ states: toList(e.target.value) })}
                  />
                </Field>
                <Field label="Lead sources" id="sources" hint="Comma-separated">
                  <input
                    id="sources"
                    className={inputClass}
                    defaultValue={(form.filter.sources ?? []).join(', ')}
                    onBlur={(e) => setFilter({ sources: toList(e.target.value) })}
                  />
                </Field>
                <Field label="Customer industries" id="industries" hint="Comma-separated">
                  <input
                    id="industries"
                    className={inputClass}
                    defaultValue={(form.filter.industries ?? []).join(', ')}
                    onBlur={(e) => setFilter({ industries: toList(e.target.value) })}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={form.filter.includeContacts ?? false}
                    onChange={(e) => setFilter({ includeContacts: e.target.checked })}
                  />
                  Also include the contacts linked to these leads
                </label>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <AudienceCard
            purpose={form.purpose}
            filter={form.filter}
            onExcludeChange={(excludeEmails) => setFilter({ excludeEmails })}
          />
          {id && existing.data && (
            <SendCard
              campaignId={id}
              dirty={isDirty(form, existing.data)}
              canSend={can(PERMISSIONS.CAMPAIGN_SEND)}
              purpose={form.purpose}
              filter={form.filter}
            />
          )}
          {!id && (
            <p className="text-sm text-slate-500">
              Create the draft to preview it, send yourself a test and send it.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function isDirty(
  form: CampaignInput,
  saved: {
    subject: string;
    html: string;
    text: string;
    assetIds: string[];
    filter: EmailRecipientFilter;
    purpose: string;
  },
): boolean {
  return (
    form.subject !== saved.subject ||
    form.purpose !== saved.purpose ||
    JSON.stringify(form.assetIds) !== JSON.stringify(saved.assetIds) ||
    JSON.stringify(clean(form.filter)) !== JSON.stringify(clean(saved.filter))
  );
}

function clean(filter: EmailRecipientFilter): EmailRecipientFilter {
  return Object.fromEntries(
    Object.entries(filter).filter(([k, v]) =>
      Array.isArray(v) ? v.length > 0 : v === true || (k === 'source' && v === 'CUSTOM'),
    ),
  ) as EmailRecipientFilter;
}

const EMAIL_SHAPE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Splits pasted text into addresses: commas, semicolons, spaces or new lines. */
export function parseEmailList(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const email = raw.trim().replace(/^<|>$/g, '').toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    (EMAIL_SHAPE.test(email) ? valid : invalid).push(email);
  }
  return { valid, invalid };
}

/**
 * Recipients typed or pasted in: one address or many. Only well-formed
 * addresses are kept; the rest are shown so they can be corrected. Each one
 * then appears in the Audience list with its own checkbox, under the same
 * eligibility and unsubscribe rules as leads.
 */
export function CustomEmailList({
  value,
  onChange,
}: {
  value: string[];
  onChange: (emails: string[]) => void;
}): React.JSX.Element {
  const [text, setText] = useState(value.join('\n'));
  const parsed = parseEmailList(text);
  const over = parsed.valid.length > MAX_CUSTOM_EMAILS;
  return (
    <div className="space-y-2 p-5 text-sm">
      <label htmlFor="custom-emails" className="block text-xs font-medium text-slate-700">
        Email addresses
      </label>
      <textarea
        id="custom-emails"
        rows={6}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseEmailList(e.target.value).valid.slice(0, MAX_CUSTOM_EMAILS));
        }}
        placeholder={'one@example.com\nanother@example.com, third@example.com'}
        className={inputClass}
      />
      <p className="text-xs text-slate-500">
        One address, or many separated by commas, spaces or new lines. Up to {MAX_CUSTOM_EMAILS}.
      </p>
      <p className="text-xs text-slate-700" data-testid="custom-count">
        {Math.min(parsed.valid.length, MAX_CUSTOM_EMAILS)}{' '}
        {parsed.valid.length === 1 ? 'address' : 'addresses'}
      </p>
      {parsed.invalid.length > 0 && (
        <p role="alert" className="text-xs text-red-700">
          Not a valid address, left out: {parsed.invalid.slice(0, 10).join(', ')}
          {parsed.invalid.length > 10 ? ` and ${parsed.invalid.length - 10} more` : ''}
        </p>
      )}
      {over && (
        <p role="alert" className="text-xs text-amber-700">
          Only the first {MAX_CUSTOM_EMAILS} addresses are used. Split the rest into another
          campaign.
        </p>
      )}
    </div>
  );
}

function AudienceCard({
  purpose,
  filter,
  onExcludeChange,
}: {
  purpose: EmailCampaignPurpose;
  filter: EmailRecipientFilter;
  onExcludeChange: (excludeEmails: string[]) => void;
}): React.JSX.Element {
  const preview = useAudiencePreview();
  // The last answer stays on screen while a new count runs, so ticking a box
  // does not make the list jump.
  const [shown, setShown] = useState<EmailAudiencePreview | null>(null);
  const key = JSON.stringify([purpose, clean(filter)]);
  useEffect(() => {
    // Short pause so ticking several boxes asks the server once, not per click.
    const timer = setTimeout(
      () =>
        preview.mutate({ purpose, filter: clean(filter) }, { onSuccess: (data) => setShown(data) }),
      400,
    );
    return () => clearTimeout(timer);
  }, [key]);
  return (
    <Card>
      <CardHeader
        title="Audience"
        subtitle="Checked again when you send, and before every message"
      />
      <div className="p-5 text-sm">
        {preview.isPending && !shown && <p className="text-slate-500">Counting…</p>}
        {preview.error && (
          <p className="text-red-700">
            {preview.error instanceof ApiError ? preview.error.message : 'Could not count.'}
          </p>
        )}
        {shown && <AudienceSummary data={shown} />}
        {shown && shown.recipients.length > 0 && (
          <RecipientChecklist
            recipients={shown.recipients}
            truncated={shown.recipientsTruncated}
            eligible={shown.eligible}
            total={shown.recipientsTotal}
            undisplayedEligible={shown.undisplayedEligible}
            excluded={filter.excludeEmails ?? []}
            onChange={onExcludeChange}
          />
        )}
      </div>
    </Card>
  );
}

/**
 * Every address the filters reach, one checkbox each: untick to leave someone
 * out of this campaign, tick again to put them back. Only shown to people who
 * may see every lead; the server applies the same list when it confirms.
 */
/** Why a listed lead cannot receive the campaign yet. */
export const INELIGIBLE_LABELS: Record<'NO_CONSENT' | 'SUPPRESSED', string> = {
  NO_CONSENT: 'Cannot receive yet: no recorded marketing eligibility',
  SUPPRESSED: 'Cannot receive: unsubscribed, bounced or suppressed',
};

export const TRUNCATION_WARNING =
  'Only the first 1,000 addresses are displayed. Additional matching recipients are still included unless excluded by other filters.';

export function RecipientChecklist({
  recipients,
  truncated,
  eligible,
  total,
  undisplayedEligible,
  excluded,
  onChange,
}: {
  recipients: EmailAudiencePreview['recipients'];
  truncated: boolean;
  /** Everyone who will receive it, displayed or not. */
  eligible: number;
  /** Everyone the list could show (eligible, taken out by hand, and not yet able to receive). */
  total: number;
  /** Eligible people outside the displayed list: they still receive it. */
  undisplayedEligible: number;
  excluded: string[];
  onChange: (excludeEmails: string[]) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const out = new Set(excluded);
  const q = search.trim().toLowerCase();
  const visible = q
    ? recipients.filter(
        (r) =>
          r.email.includes(q) ||
          (r.name ?? '').toLowerCase().includes(q) ||
          (r.company ?? '').toLowerCase().includes(q),
      )
    : recipients;
  const setAll = (include: boolean) => {
    const next = new Set(out);
    for (const r of visible) {
      if (include) next.delete(r.email);
      else next.add(r.email);
    }
    onChange([...next]);
  };
  const toggle = (email: string) => {
    const next = new Set(out);
    if (next.has(email)) next.delete(email);
    else next.add(email);
    onChange([...next]);
  };
  const included = recipients.filter((r) => !out.has(r.email)).length;
  const notDisplayed = Math.max(0, total - recipients.length);
  const tickedButBlocked = recipients.filter((r) => r.ineligible && !out.has(r.email)).length;
  return (
    <fieldset className="mt-4 border-t border-slate-100 pt-3">
      <legend className="sr-only">Recipients</legend>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-700">
          {included} of {recipients.length} displayed selected
        </span>
        <span className="flex gap-2">
          <button type="button" className="underline" onClick={() => setAll(true)}>
            Select all displayed
          </button>
          <button type="button" className="underline" onClick={() => setAll(false)}>
            Deselect all displayed
          </button>
        </span>
      </div>
      {truncated && (
        <div
          role="alert"
          className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          <p className="font-medium">{TRUNCATION_WARNING}</p>
          <dl className="mt-1 grid grid-cols-3 gap-2">
            <div>
              <dt>Total eligible audience</dt>
              <dd className="font-semibold tabular-nums" data-testid="total-eligible">
                {eligible}
              </dd>
            </div>
            <div>
              <dt>Displayed</dt>
              <dd className="font-semibold tabular-nums">{recipients.length}</dd>
            </div>
            <div>
              <dt>Not displayed</dt>
              <dd className="font-semibold tabular-nums" data-testid="not-displayed">
                {notDisplayed}
              </dd>
            </div>
          </dl>
          {undisplayedEligible > 0 && (
            <p className="mt-1">
              <strong>{undisplayedEligible}</strong> recipients who are not displayed{' '}
              <strong>will still receive</strong> this campaign. Deselecting all displayed addresses
              does not reach them; narrow the filters to leave them out.
            </p>
          )}
        </div>
      )}
      {tickedButBlocked > 0 && (
        <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {tickedButBlocked} ticked {tickedButBlocked === 1 ? 'lead' : 'leads'} cannot receive this
          campaign yet (see the note under each). They stay in the group but are skipped until that
          changes; untick to leave them out for good.
        </p>
      )}
      <input
        type="search"
        aria-label="Search recipients"
        placeholder="Search name, email or company"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-2 w-full rounded-lg border border-slate-200 px-2 py-1 text-xs"
      />
      <ul className="max-h-72 space-y-1 overflow-y-auto pr-1 text-xs">
        {visible.map((r) => (
          <li key={r.email}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!out.has(r.email)}
                onChange={() => toggle(r.email)}
              />
              <span className="min-w-0">
                <span className="block truncate text-slate-800">{r.name ?? r.email}</span>
                <span className="block truncate text-slate-500">
                  {r.name ? r.email : ''}
                  {r.company ? `${r.name ? ' · ' : ''}${r.company}` : ''}
                </span>
                {r.ineligible && (
                  <span className="block text-amber-700">{INELIGIBLE_LABELS[r.ineligible]}</span>
                )}
              </span>
            </label>
          </li>
        ))}
        {visible.length === 0 && <li className="text-slate-500">No match.</li>}
      </ul>
    </fieldset>
  );
}

function AudienceSummary({ data }: { data: EmailAudiencePreview }): React.JSX.Element {
  const excluded = Object.entries(data.excluded).filter(([, n]) => n > 0);
  return (
    <div className="space-y-3">
      <p>
        <span className="text-2xl font-semibold tabular-nums text-slate-900">{data.eligible}</span>{' '}
        <span className="text-slate-600">will receive it</span>
        <span className="block text-xs text-slate-500">{data.selected} matched the filters</span>
      </p>
      {excluded.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-600">
          {excluded.map(([reason, n]) => (
            <li key={reason}>
              {n} left out — {EXCLUSION_LABELS[reason] ?? reason}
            </li>
          ))}
        </ul>
      )}
      {data.excluded.NO_CONSENT > 0 && (
        <p className="text-xs text-slate-500">
          Record eligibility in{' '}
          <Link to="/campaigns/eligibility" className="underline">
            Marketing eligibility
          </Link>
          .
        </p>
      )}
      {data.sample.length > 0 && (
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer">First {data.sample.length} recipients</summary>
          <ul className="mt-2 space-y-0.5">
            {data.sample.map((s) => (
              <li key={s.email}>
                {s.name ? `${s.name} · ` : ''}
                {s.email}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SendCard({
  campaignId,
  dirty,
  canSend,
  purpose,
  filter,
}: {
  campaignId: string;
  dirty: boolean;
  canSend: boolean;
  purpose: EmailCampaignPurpose;
  filter: EmailRecipientFilter;
}): React.JSX.Element {
  const preview = useRenderedPreview(campaignId);
  const test = useTestSend();
  const mailbox = useMailbox();
  // Enabled exactly when the server would accept a test send (see sending-readiness.ts).
  const ready = sendingReadiness(mailbox.data).testSend;
  const [confirming, setConfirming] = useState(false);
  const [otherAddress, setOtherAddress] = useState('');
  const other = otherAddress.trim().toLowerCase();
  const testBlocked = dirty || test.isPending || !mailbox.data || !ready.ok;
  const { user } = useAuth();
  const sendingTo = test.isPending ? (test.variables?.to ? 'other' : 'me') : null;
  return (
    <Card>
      <CardHeader title="Preview and send" />
      <div className="space-y-4 p-5 text-sm">
        {dirty && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Save the draft to preview and send the latest version.
          </p>
        )}
        {preview.data && (
          <>
            <p className="text-xs text-slate-500">Subject</p>
            <p className="font-medium text-slate-900">{preview.data.subject}</p>
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={preview.data.html}
              className="h-80 w-full rounded-lg border border-slate-200 bg-white"
            />
            {preview.data.attachments.length > 0 && (
              <p className="text-xs text-slate-600">
                Attachments: {preview.data.attachments.map((a) => a.fileName).join(', ')}
              </p>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-600">Plain-text version</summary>
              <pre className="mt-2 whitespace-pre-wrap text-slate-700">{preview.data.text}</pre>
            </details>
          </>
        )}
        <section
          aria-labelledby="test-email-heading"
          className="space-y-3 rounded-lg border border-slate-200 p-3"
        >
          <div>
            <h3 id="test-email-heading" className="text-sm font-medium text-slate-900">
              Test email
            </h3>
            <p className="text-xs text-slate-500">
              One [TEST] copy goes only to the address on the button you click — never to this
              campaign’s recipients.
            </p>
          </div>
          <button
            type="button"
            disabled={testBlocked}
            onClick={() => test.mutate({ id: campaignId })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 hover:bg-slate-50 disabled:opacity-50"
          >
            {sendingTo === 'me'
              ? 'Sending test…'
              : user?.email
                ? `Send test to me (${user.email})`
                : 'Send test to me'}
          </button>
          <div className="space-y-2 border-t border-slate-200 pt-3 text-xs">
            <h4 className="text-sm font-medium text-slate-900">
              Send test to another approved email
            </h4>
            <label className="block text-slate-600">
              Approved email address
              <input
                type="email"
                value={otherAddress}
                onChange={(e) => setOtherAddress(e.target.value)}
                maxLength={254}
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <p className="text-slate-500">
              Only addresses approved on this server can receive test emails. Any other address is
              refused — it is never replaced by yours.
            </p>
            <button
              type="button"
              disabled={testBlocked || !EMAIL_SHAPE.test(other)}
              onClick={() => test.mutate({ id: campaignId, to: other })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 hover:bg-slate-50 disabled:opacity-50"
            >
              {sendingTo === 'other'
                ? 'Sending test…'
                : EMAIL_SHAPE.test(other)
                  ? `Send test to ${other}`
                  : 'Send test to this address'}
            </button>
          </div>
        </section>
        {mailbox.data && !ready.ok && (
          <ul
            aria-label="Why test emails are unavailable"
            className="list-disc space-y-0.5 pl-5 text-xs text-slate-500"
          >
            {ready.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {test.data && (
          <p
            role="status"
            className={`text-xs ${test.data.accepted ? 'text-emerald-700' : 'text-red-700'}`}
          >
            {test.data.message}
          </p>
        )}
        {test.error && (
          <p role="alert" className="text-xs text-red-700">
            {test.error instanceof ApiError ? test.error.message : 'Test failed.'}
          </p>
        )}
        {canSend ? (
          <button
            type="button"
            disabled={dirty}
            onClick={() => setConfirming(true)}
            className="w-full rounded-lg bg-slate-900 px-3 py-2 font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Review and send…
          </button>
        ) : (
          <p className="text-xs text-slate-500">An owner or admin sends campaigns.</p>
        )}
      </div>
      {confirming && (
        <ConfirmDialog
          campaignId={campaignId}
          purpose={purpose}
          filter={filter}
          onClose={() => setConfirming(false)}
        />
      )}
    </Card>
  );
}

export function ConfirmDialog({
  campaignId,
  purpose,
  filter,
  onClose,
}: {
  campaignId: string;
  purpose: EmailCampaignPurpose;
  filter: EmailRecipientFilter;
  onClose: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const audience = useAudiencePreview();
  const action = useCampaignAction();
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  // One key per dialog: a double click confirms once.
  const submitKey = useMemo(() => crypto.randomUUID().replace(/-/g, ''), []);
  useEffect(() => {
    audience.mutate({ purpose, filter: clean(filter) });
  }, []);
  const count = audience.data?.eligible ?? 0;
  const undisplayed = audience.data?.undisplayedEligible ?? 0;
  // Anyone who will receive it without having been shown in the list must be
  // acknowledged explicitly: "Deselect all displayed" is never "send to nobody".
  const [acknowledged, setAcknowledged] = useState(false);
  const needsAck = audience.data?.recipientsListed === true && undisplayed > 0;
  const send = () =>
    action.mutate(
      {
        id: campaignId,
        action: 'confirm',
        body: {
          submitKey,
          eligibleCount: count,
          ...(when === 'later' && at ? { scheduledAt: new Date(at).toISOString() } : {}),
        },
      },
      { onSuccess: () => navigate(`/campaigns/${campaignId}`) },
    );
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 id="confirm-title" className="text-base font-semibold text-slate-900">
          Send this campaign?
        </h2>
        {audience.isPending && (
          <p className="mt-3 text-sm text-slate-500">Checking the audience…</p>
        )}
        {audience.data && (
          <p className="mt-3 text-sm text-slate-700">
            It will be sent to <strong>{count}</strong> {count === 1 ? 'person' : 'people'}, one
            email each, from your company mailbox. This cannot be undone once a message has been
            handed to the mail server; queued messages can still be paused or cancelled.
          </p>
        )}
        {audience.data?.recipientsListed && (
          <dl
            aria-label="Audience breakdown"
            className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700"
          >
            <dt>Total eligible recipients</dt>
            <dd className="text-right font-semibold tabular-nums">{count}</dd>
            <dt>Displayed in the list</dt>
            <dd className="text-right font-semibold tabular-nums">
              {audience.data.recipients.length}
            </dd>
            <dt>Not displayed</dt>
            <dd className="text-right font-semibold tabular-nums">
              {Math.max(0, audience.data.recipientsTotal - audience.data.recipients.length)}
            </dd>
            <dt>Excluded by hand</dt>
            <dd className="text-right font-semibold tabular-nums">
              {audience.data.excluded.EXCLUDED ?? 0}
            </dd>
          </dl>
        )}
        {audience.data && !audience.data.recipientsListed && (
          <p className="mt-3 text-xs text-slate-600">
            The address list is not available to your role; all {count} eligible recipients will
            receive it.
          </p>
        )}
        {needsAck && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <p>
              <strong>{undisplayed}</strong> {undisplayed === 1 ? 'recipient' : 'recipients'} not
              displayed in the list <strong>will receive this campaign</strong>.
            </p>
            <label className="mt-2 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              I understand that {undisplayed} recipients I have not seen in the list will receive
              it.
            </label>
          </div>
        )}
        <div className="mt-4 space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} /> Send now
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} />{' '}
            Schedule
            <input
              type="datetime-local"
              disabled={when !== 'later'}
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
        </div>
        {action.error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {action.error instanceof ApiError ? action.error.message : 'Could not send.'}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={
              action.isPending ||
              audience.isPending ||
              count === 0 ||
              (when === 'later' && !at) ||
              (needsAck && !acknowledged)
            }
            onClick={send}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {action.isPending
              ? 'Sending…'
              : when === 'later'
                ? `Schedule for ${count}`
                : `Send to ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A small rich-text editor: bold, italic, heading, lists, links and merge
 * fields. What it produces is only a suggestion — the server sanitizes it.
 */
function RichTextEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (html: string) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value && document.activeElement !== ref.current)
      ref.current.innerHTML = value;
  }, [value]);
  const exec = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    if (ref.current) onChange(ref.current.innerHTML);
  };
  const tool = 'rounded px-2 py-1 text-xs hover:bg-slate-100';
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-slate-700">Message</p>
      <div className="flex flex-wrap items-center gap-1 rounded-t-lg border border-b-0 border-slate-300 bg-slate-50 p-1">
        <button type="button" className={`${tool} font-bold`} onClick={() => exec('bold')}>
          B
        </button>
        <button type="button" className={`${tool} italic`} onClick={() => exec('italic')}>
          I
        </button>
        <button type="button" className={tool} onClick={() => exec('formatBlock', 'h2')}>
          Heading
        </button>
        <button type="button" className={tool} onClick={() => exec('formatBlock', 'p')}>
          Paragraph
        </button>
        <button type="button" className={tool} onClick={() => exec('insertUnorderedList')}>
          • List
        </button>
        <button
          type="button"
          className={tool}
          onClick={() => {
            const url = window.prompt('Link address (https://…)');
            if (url && /^(https?:\/\/|mailto:)/i.test(url)) exec('createLink', url);
          }}
        >
          Link
        </button>
        <select
          className="ml-auto rounded border border-slate-300 bg-white px-1 py-0.5 text-xs"
          value=""
          onChange={(e) => e.target.value && exec('insertText', `{{${e.target.value}}}`)}
        >
          <option value="">Insert field…</option>
          {EMAIL_MERGE_FIELDS.map((f) => (
            <option key={f} value={f}>
              {f.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
        className="prose prose-sm min-h-48 max-w-none rounded-b-lg border border-slate-300 bg-white p-3 focus:outline-none"
      />
    </div>
  );
}

function AttachmentPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}): React.JSX.Element {
  const assets = useAssets();
  const upload = useUploadAsset();
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-slate-700">Attachments</p>
      <ul className="space-y-1 text-sm">
        {assets.data?.map((a) => (
          <li key={a.id}>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selected.includes(a.id)}
                onChange={() => toggle(a.id)}
              />
              {a.fileName}{' '}
              <span className="text-xs text-slate-500">
                ({Math.ceil(a.sizeBytes / 1024)} KB{a.productName ? ` · ${a.productName}` : ''})
              </span>
            </label>
          </li>
        ))}
      </ul>
      <label className="mt-2 inline-block cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">
        Upload PDF, PNG or JPEG (max 5 MB)
        <input
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              upload.mutate({ file }, { onSuccess: (asset) => onChange([...selected, asset.id]) });
            e.target.value = '';
          }}
        />
      </label>
      {upload.error && (
        <p className="mt-1 text-xs text-red-700">
          {upload.error instanceof ApiError ? upload.error.message : 'Upload failed.'}
        </p>
      )}
    </div>
  );
}

function MultiCheck({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  labels?: Record<string, string>;
  value: string[];
  onChange: (v: string[]) => void;
}): React.JSX.Element {
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium text-slate-700">{label}</legend>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {options.map((o) => (
          <label key={o} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={value.includes(o)}
              onChange={() =>
                onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o])
              }
            />
            {labels?.[o] ?? o.replace(/_/g, ' ').toLowerCase()}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Cities from this organization's own leads, one checkbox each (with how many
 * leads have an email there). None ticked means every city.
 */
export function CityChecklist({
  cities,
  value,
  onChange,
}: {
  cities: { name: string; count: number }[];
  value: string[];
  onChange: (cities: string[]) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const picked = new Set(value.map((v) => v.toLowerCase()));
  const q = search.trim().toLowerCase();
  const visible = q ? cities.filter((c) => c.name.toLowerCase().includes(q)) : cities;
  const toggle = (name: string) =>
    onChange(
      picked.has(name.toLowerCase())
        ? value.filter((v) => v.toLowerCase() !== name.toLowerCase())
        : [...value, name],
    );
  return (
    <fieldset className="sm:col-span-2">
      <legend className="mb-1 text-xs font-medium text-slate-700">
        Cities{' '}
        <span className="font-normal text-slate-500">
          {value.length === 0 ? '(none ticked = every city)' : `(${value.length} ticked)`}
        </span>
      </legend>
      {cities.length === 0 ? (
        <p className="text-xs text-slate-500">No lead with an email has a city yet.</p>
      ) : (
        <>
          <div className="mb-1 flex items-center gap-2">
            <input
              type="search"
              aria-label="Search cities"
              placeholder="Search cities"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs"
            />
            {value.length > 0 && (
              <button type="button" className="text-xs underline" onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>
          <div className="flex max-h-40 flex-wrap gap-x-3 gap-y-1 overflow-y-auto text-xs">
            {visible.map((c) => (
              <label key={c.name} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={picked.has(c.name.toLowerCase())}
                  onChange={() => toggle(c.name)}
                />
                {c.name} <span className="text-slate-400">({c.count})</span>
              </label>
            ))}
          </div>
        </>
      )}
    </fieldset>
  );
}

function Field({
  label,
  id,
  hint,
  children,
}: {
  label: string;
  id: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
