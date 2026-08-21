import { useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, apiPost } from '../../lib/api-client';
import { usePageMeta } from '../../lib/use-page-meta';
import { SectionHeading } from './marketing-layout';

/** Kept in one place so the address on the page and in the mailto agree. */
const SALES_EMAIL = 'sales@cravionventures.com';

interface EnquiryReceipt {
  reference: string;
  salesEmail: string;
}

/**
 * The public enquiry form.
 *
 * Sends to the API, which stores the enquiry and then notifies the sales inbox
 * — in that order, so a mail outage loses the notification rather than the
 * customer. The address is never sent from here: the server takes it from
 * configuration, because a caller-supplied recipient would make this an open
 * relay.
 */
export function ContactPage(): React.JSX.Element {
  usePageMeta(
    'Contact — LeadFlow',
    `Questions about LeadFlow? Send us a message or email ${SALES_EMAIL}.`,
  );

  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pt-16 pb-16 sm:px-6 sm:pt-20">
        <SectionHeading
          title="Talk to us"
          subtitle="Questions about whether LeadFlow fits your team, how the trial works, or what it will cost. A real person reads these."
        />

        <div className="mt-12 grid gap-12 lg:grid-cols-[1fr_360px] lg:gap-16">
          <EnquiryForm />
          <ContactDetails />
        </div>
      </section>
    </>
  );
}

function EnquiryForm(): React.JSX.Element {
  const ids = {
    name: useId(),
    email: useId(),
    company: useId(),
    phone: useId(),
    country: useId(),
    message: useId(),
    website: useId(),
  };

  const [form, setForm] = useState({
    name: '',
    email: '',
    company: '',
    phone: '',
    country: '',
    message: '',
    // Honeypot. Hidden from people, irresistible to form-filling bots.
    website: '',
  });

  const submit = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<EnquiryReceipt>('/contact', body),
  });

  const set =
    (field: keyof typeof form) =>
    (event: { target: { value: string } }): void =>
      setForm((current) => ({ ...current, [field]: event.target.value }));

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();

    submit.mutate({
      name: form.name.trim(),
      email: form.email.trim(),
      ...(form.company.trim() ? { company: form.company.trim() } : {}),
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      ...(form.country ? { country: form.country } : {}),
      message: form.message.trim(),
      source: 'contact',
      ...(form.website ? { website: form.website } : {}),
    });
  };

  if (submit.isSuccess) {
    return (
      <div
        role="status"
        className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 sm:p-8"
      >
        <h2 className="text-lg font-semibold text-emerald-900">Thanks — we have it</h2>
        <p className="mt-2 text-sm text-pretty text-emerald-800">
          We usually reply within one working day. Your reference is{' '}
          <span className="font-mono font-medium">{submit.data.reference}</span> — quote it if
          you follow up.
        </p>
        <p className="mt-4 text-sm text-emerald-800">
          A reply will come from{' '}
          <a href={`mailto:${submit.data.salesEmail}`} className="font-medium underline">
            {submit.data.salesEmail}
          </a>
          .
        </p>
      </div>
    );
  }

  const fieldError = (field: string): string | undefined =>
    submit.error instanceof ApiError ? submit.error.details?.[field]?.[0] : undefined;

  const rateLimited = submit.error instanceof ApiError && submit.error.status === 429;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Your name" htmlFor={ids.name} required error={fieldError('name')}>
          <input
            id={ids.name}
            value={form.name}
            onChange={set('name')}
            autoComplete="name"
            required
            aria-invalid={fieldError('name') ? true : undefined}
            className={inputClass}
          />
        </Field>

        <Field label="Work email" htmlFor={ids.email} required error={fieldError('email')}>
          <input
            id={ids.email}
            type="email"
            value={form.email}
            onChange={set('email')}
            autoComplete="email"
            required
            aria-invalid={fieldError('email') ? true : undefined}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Company" htmlFor={ids.company} hint="Optional">
          <input
            id={ids.company}
            value={form.company}
            onChange={set('company')}
            autoComplete="organization"
            className={inputClass}
          />
        </Field>

        <Field label="Phone" htmlFor={ids.phone} hint="Optional">
          <input
            id={ids.phone}
            type="tel"
            value={form.phone}
            onChange={set('phone')}
            autoComplete="tel"
            className={inputClass}
          />
        </Field>
      </div>

      <Field
        label="Country"
        htmlFor={ids.country}
        hint="Optional — helps us answer in your timezone and currency"
      >
        <select
          id={ids.country}
          value={form.country}
          onChange={set('country')}
          className={inputClass}
        >
          <option value="">Select a country…</option>
          {COUNTRIES.map((code) => (
            <option key={code} value={code}>
              {countryName(code)}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="How can we help?"
        htmlFor={ids.message}
        required
        error={fieldError('message')}
        hint="Team size and what you use today is usually enough to get a useful answer."
      >
        <textarea
          id={ids.message}
          value={form.message}
          onChange={set('message')}
          rows={6}
          required
          aria-invalid={fieldError('message') ? true : undefined}
          className={`${inputClass} resize-y`}
        />
      </Field>

      {/*
        Honeypot. Hidden from people with position rather than `display:none`,
        which some bots detect, and taken out of the tab order and the
        accessibility tree so nobody using a keyboard or screen reader can fill
        it by accident.
      */}
      <div aria-hidden className="pointer-events-none absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor={ids.website}>Website (leave this blank)</label>
        <input
          id={ids.website}
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={form.website}
          onChange={set('website')}
        />
      </div>

      {submit.isError && (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {rateLimited
            ? `You have sent several messages recently. Please email ${SALES_EMAIL} directly and we will pick it up.`
            : submit.error instanceof ApiError
              ? submit.error.message
              : 'Your message could not be sent. Please try again, or email us directly.'}
        </p>
      )}

      <button
        type="submit"
        disabled={submit.isPending}
        className="w-full rounded-lg bg-slate-900 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50 sm:w-auto"
      >
        {submit.isPending ? 'Sending…' : 'Send message'}
      </button>

      <p className="text-xs text-slate-400">
        We use what you send here to answer your question. Nothing else.
      </p>
    </form>
  );
}

function ContactDetails(): React.JSX.Element {
  return (
    <aside className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
        <h2 className="text-sm font-semibold text-slate-900">Prefer email?</h2>
        <p className="mt-2 text-sm text-slate-600">Write to us directly at</p>
        <a
          href={`mailto:${SALES_EMAIL}`}
          className="mt-1 block text-sm font-medium break-all text-slate-900 underline underline-offset-4"
        >
          {SALES_EMAIL}
        </a>
      </div>

      <div className="rounded-xl border border-slate-200 p-6">
        <h2 className="text-sm font-semibold text-slate-900">Already a customer?</h2>
        <p className="mt-2 text-sm text-pretty text-slate-600">
          Sign in and use the same address — mentioning your organization name helps us find you
          faster.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 p-6">
        <h2 className="text-sm font-semibold text-slate-900">What to expect</h2>
        <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
          <li>A reply within one working day</li>
          <li>No automated sales sequence</li>
          <li>A straight answer about whether it fits</li>
        </ul>
      </div>
    </aside>
  );
}

/**
 * Countries offered on the enquiry form.
 *
 * A curated list rather than all 249 regions. The field exists so a reply can
 * be pitched in the right timezone and currency, and a 249-entry dropdown makes
 * the common case harder without helping the rare one. The API accepts any
 * valid ISO 3166-1 code, so nothing here restricts what can be stored.
 */
const COUNTRIES = [
  'US', 'GB', 'IN', 'CA', 'AU', 'NZ', 'IE', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE',
  'SE', 'NO', 'DK', 'FI', 'PL', 'PT', 'CH', 'AT', 'AE', 'SA', 'QA', 'SG', 'MY',
  'ID', 'PH', 'TH', 'VN', 'JP', 'KR', 'CN', 'HK', 'BD', 'PK', 'LK', 'NP',
  'ZA', 'NG', 'KE', 'GH', 'EG', 'BR', 'MX', 'AR', 'CL', 'CO',
].sort((a, b) => countryName(a).localeCompare(countryName(b)));

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-1 focus:ring-slate-900 aria-invalid:border-red-400';

function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | undefined;
  required?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
        {required && (
          <>
            <span aria-hidden className="ml-0.5 text-red-500">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>
      {children}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

export { SALES_EMAIL };
