import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Copyright, LogoMark } from '../../components/brand';

/**
 * Shared chrome and form primitives for the unauthenticated screens.
 *
 * Accessibility is built in here rather than repeated per screen: every input
 * gets a real `<label for>`, errors are announced through `aria-live` and tied
 * to the field with `aria-describedby`, and invalid fields carry
 * `aria-invalid`. Doing this once is the only way it stays consistent.
 */

export function AuthLayout({
  title,
  subtitle,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  wide?: boolean;
}): React.JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);

  // Move focus to the heading on mount so a keyboard or screen-reader user
  // lands on the page content rather than at the top of the document.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className={wide ? 'w-full max-w-lg' : 'w-full max-w-sm'}>
        <div className="mb-8 text-center">
          <Link to="/" aria-label="LeadFlow home" className="mx-auto mb-3 block w-fit">
            <LogoMark className="h-10 w-10" />
          </Link>
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-xl font-semibold tracking-tight text-slate-900 outline-none"
          >
            {title}
          </h1>
          {subtitle && <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">{children}</div>

        <Copyright className="mt-6 text-center" />
      </div>
    </div>
  );
}

export function AuthField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  required,
  hint,
  error,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  hint?: string;
  error?: string | undefined;
  disabled?: boolean;
}): React.JSX.Element {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && (
          <span className="ml-0.5 text-red-500" aria-hidden>
            *
          </span>
        )}
      </label>

      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-1 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-500 aria-[invalid]:border-red-400"
      />

      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SubmitButton({
  submitting,
  label,
  busyLabel,
}: {
  submitting: boolean;
  label: string;
  busyLabel: string;
}): React.JSX.Element {
  return (
    <button
      type="submit"
      disabled={submitting}
      // aria-busy tells assistive technology the form is working; the visible
      // label change tells everyone else.
      aria-busy={submitting}
      className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-50"
    >
      {submitting ? busyLabel : label}
    </button>
  );
}
