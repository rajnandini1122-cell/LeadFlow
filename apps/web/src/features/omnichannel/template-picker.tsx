import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api-client';
import { ErrorNotice, SkeletonRows } from '../../components/ui';
import {
  useSendTemplate,
  useWhatsAppTemplates,
  type ConversationDetail,
  type WhatsAppTemplate,
} from './use-conversations';

/**
 * Choosing and sending an approved WhatsApp template.
 *
 * The only way to message a customer whose 24-hour window has closed, and it is
 * deliberately a distinct action from the composer: a different button, a
 * different endpoint, a different hook. Typed text is never turned into a
 * template, and a refused free-form send never becomes one — a customer
 * receiving a templated message they did not expect, and an owner receiving the
 * bill for it, is a worse outcome than a refusal somebody can see.
 *
 * Three rules hold throughout:
 *
 *   - Meta decides what is approved. This renders `status` and refuses anything
 *     that is not APPROVED and supported. It never manufactures an answer.
 *   - The parameter rules come from the API's counts, not from parsing the
 *     template text here. A second implementation of the same rule is a second
 *     thing to get wrong, and the server validates again regardless.
 *   - Nothing is shown as sent until the API has accepted it.
 */
export function TemplatePicker({
  conversation,
  onClose,
}: {
  conversation: ConversationDetail;
  onClose: () => void;
}): React.JSX.Element {
  const templates = useWhatsAppTemplates();
  const send = useSendTemplate(conversation.id);

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [values, setValues] = useState<{ header: string[]; body: string[] }>({
    header: [],
    body: [],
  });
  const [failure, setFailure] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);

  /*
   * One key per composed message, regenerated only after a success.
   *
   * The same guarantee the free-form composer relies on: every retry of the
   * SAME template send carries the key the server already knows, so a double
   * click cannot reach a customer twice.
   */
  const idempotencyKey = useRef(crypto.randomUUID());

  const items = templates.data?.items ?? [];

  /** Approved AND supported. Anything else is shown but cannot be chosen. */
  const sendable = useMemo(
    () => items.filter((item) => item.status === 'APPROVED' && item.supported),
    [items],
  );

  const selected = useMemo(
    () => sendable.find((item) => `${item.name}:${item.language}` === selectedName) ?? null,
    [sendable, selectedName],
  );

  const choose = (template: WhatsAppTemplate): void => {
    setSelectedName(`${template.name}:${template.language}`);
    // Empty strings, not guesses. A missing value is the user's to supply.
    setValues({
      header: Array.from({ length: template.headerParameterCount }, () => ''),
      body: Array.from({ length: template.bodyParameterCount }, () => ''),
    });
    setValidation(null);
    setFailure(null);
  };

  const setValue = (section: 'header' | 'body', index: number, value: string): void => {
    setValues((current) => {
      const next = [...current[section]];
      next[index] = value;
      return { ...current, [section]: next };
    });
    setValidation(null);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!selected || send.isPending) return;

    // A blank placeholder reaches the customer as a gap in a sentence, so it
    // is caught here as well as on the server.
    const blank = [...values.header, ...values.body].some((value) => value.trim().length === 0);
    if (blank) {
      setValidation('Fill in every value before sending.');
      return;
    }

    setFailure(null);
    send.mutate(
      {
        templateName: selected.name,
        language: selected.language,
        headerParameters: values.header,
        bodyParameters: values.body,
        idempotencyKey: idempotencyKey.current,
      },
      {
        onSuccess: () => {
          idempotencyKey.current = crypto.randomUUID();
          // The conversation query is invalidated by the hook, so the message
          // appears from the server's answer rather than an optimistic guess.
          onClose();
        },
        onError: (error) => {
          setFailure(
            error instanceof ApiError
              ? error.message
              : 'Could not send the template. Please try again.',
          );
        },
      },
    );
  };

  return (
    <div className="border-t border-slate-200 bg-slate-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Send a template</h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-slate-500 transition hover:bg-slate-200"
        >
          Cancel
        </button>
      </div>

      {templates.isPending && <SkeletonRows rows={2} />}

      {templates.isError && (
        <ErrorNotice message="Could not load templates. Please try again." />
      )}

      {templates.isSuccess && sendable.length === 0 && (
        <p className="text-xs text-pretty text-slate-600">
          No approved templates are available. Templates are created and approved in Meta, then
          loaded from Settings → Channel integrations.
        </p>
      )}

      {templates.isSuccess && sendable.length > 0 && (
        <form onSubmit={submit}>
          <label
            htmlFor="template-choice"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Template
          </label>
          <select
            id="template-choice"
            value={selectedName ?? ''}
            disabled={send.isPending}
            onChange={(event) => {
              const match = sendable.find(
                (item) => `${item.name}:${item.language}` === event.target.value,
              );
              if (match) choose(match);
            }}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="">Choose a template…</option>
            {sendable.map((item) => (
              <option key={`${item.name}:${item.language}`} value={`${item.name}:${item.language}`}>
                {item.name} ({item.language})
                {item.category ? ` · ${item.category}` : ''}
              </option>
            ))}
          </select>

          {selected && (
            <>
              {/*
                * The template text as Meta holds it, placeholders included.
                * Shown so the person choosing can see what the customer will
                * receive before they commit to sending it.
                */}
              <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
                <p className="mb-1 text-[11px] font-medium tracking-wide text-slate-500 uppercase">
                  Preview
                </p>
                {selected.headerText && (
                  <p className="text-sm font-semibold text-slate-800">
                    {fill(selected.headerText, values.header)}
                  </p>
                )}
                {selected.bodyText && (
                  <p className="mt-1 text-sm whitespace-pre-wrap text-slate-700">
                    {fill(selected.bodyText, values.body)}
                  </p>
                )}
                {selected.footerText && (
                  <p className="mt-1 text-xs text-slate-500">{selected.footerText}</p>
                )}
                {selected.buttons.length > 0 && (
                  <p className="mt-2 text-[11px] text-slate-400">
                    Buttons: {selected.buttons.join(', ')}
                  </p>
                )}
              </div>

              {(selected.headerParameterCount > 0 || selected.bodyParameterCount > 0) && (
                <div className="mt-3 space-y-2">
                  {values.header.map((value, index) => (
                    <ValueField
                      key={`header-${index}`}
                      id={`template-header-${index}`}
                      label={`Header value ${index + 1}`}
                      value={value}
                      disabled={send.isPending}
                      onChange={(next) => setValue('header', index, next)}
                    />
                  ))}
                  {values.body.map((value, index) => (
                    <ValueField
                      key={`body-${index}`}
                      id={`template-body-${index}`}
                      label={`Value ${index + 1}`}
                      value={value}
                      disabled={send.isPending}
                      onChange={(next) => setValue('body', index, next)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {validation && (
            <p role="alert" className="mt-2 text-xs text-red-700">
              {validation}
            </p>
          )}

          {failure && (
            <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {failure}
            </p>
          )}

          <button
            type="submit"
            // Disabled in flight, so a second click cannot start a second send.
            disabled={!selected || send.isPending}
            className="mt-3 w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {send.isPending ? 'Sending…' : 'Send template'}
          </button>
        </form>
      )}
    </div>
  );
}

function ValueField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-600">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        maxLength={1024}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
      />
    </div>
  );
}

/**
 * The preview only.
 *
 * Substitution here is for the person choosing the template; the message that
 * actually reaches the customer is rendered by the API from the stored
 * definition. A placeholder with no value yet is left visible rather than
 * blanked, so an unfilled blank is obvious instead of silently disappearing.
 */
function fill(text: string, values: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index: string) => {
    const value = values[Number(index) - 1];
    return value && value.trim().length > 0 ? value : match;
  });
}
