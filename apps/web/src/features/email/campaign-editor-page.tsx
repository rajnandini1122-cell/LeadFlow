import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  EMAIL_CAMPAIGN_CATEGORIES,
  EMAIL_MERGE_FIELDS,
  LEAD_PRIORITIES,
  LEAD_STATUSES,
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

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:ring-1 focus:ring-slate-900 focus:outline-none';

const EXCLUSION_LABELS: Record<string, string> = {
  NO_CONSENT: 'no recorded marketing eligibility',
  SUPPRESSED: 'unsubscribed, bounced or suppressed',
  INVALID: 'no valid email address',
  DUPLICATE: 'same address reached twice',
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
              title="Recipients"
              subtitle="Leads with an email address. Filters combine (all must match)."
            />
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
              <Field label="Cities" id="cities" hint="Comma-separated">
                <input
                  id="cities"
                  className={inputClass}
                  defaultValue={(form.filter.cities ?? []).join(', ')}
                  onBlur={(e) => setFilter({ cities: toList(e.target.value) })}
                />
              </Field>
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
          </Card>
        </div>

        <div className="space-y-6">
          <AudienceCard purpose={form.purpose} filter={form.filter} />
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
    Object.entries(filter).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v === true)),
  ) as EmailRecipientFilter;
}

function AudienceCard({
  purpose,
  filter,
}: {
  purpose: EmailCampaignPurpose;
  filter: EmailRecipientFilter;
}): React.JSX.Element {
  const preview = useAudiencePreview();
  const key = JSON.stringify([purpose, clean(filter)]);
  useEffect(() => {
    preview.mutate({ purpose, filter: clean(filter) });
  }, [key]);
  return (
    <Card>
      <CardHeader
        title="Audience"
        subtitle="Checked again when you send, and before every message"
      />
      <div className="p-5 text-sm">
        {preview.isPending && <p className="text-slate-500">Counting…</p>}
        {preview.error && (
          <p className="text-red-700">
            {preview.error instanceof ApiError ? preview.error.message : 'Could not count.'}
          </p>
        )}
        {preview.data && <AudienceSummary data={preview.data} />}
      </div>
    </Card>
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
  const [confirming, setConfirming] = useState(false);
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
        <button
          type="button"
          disabled={dirty || test.isPending || !mailbox.data?.smtp.okAt}
          onClick={() => test.mutate(campaignId)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 hover:bg-slate-50 disabled:opacity-50"
        >
          {test.isPending ? 'Sending test…' : 'Send me a test email'}
        </button>
        {!mailbox.data?.smtp.okAt && (
          <p className="text-xs text-slate-500">Connect and test the email account first.</p>
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

function ConfirmDialog({
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
              action.isPending || audience.isPending || count === 0 || (when === 'later' && !at)
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
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
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
            {o.replace(/_/g, ' ').toLowerCase()}
          </label>
        ))}
      </div>
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
