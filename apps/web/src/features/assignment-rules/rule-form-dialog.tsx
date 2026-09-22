import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AssignmentRuleView, TeamListItem } from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';

export interface RuleFormValues {
  name: string;
  description: string;
  priority: string;
  source: string;
  productId: string;
  isFallback: boolean;
  targetTeamId: string;
}

/**
 * Create or edit one routing rule.
 *
 * The fallback is a deliberate choice on this form rather than something an
 * administrator falls into by leaving the criteria empty: ticking it hides the
 * criteria, because a fallback that quietly declines to catch things is the
 * one failure a catch-all must not have.
 */
export function RuleFormDialog({
  open,
  rule,
  teams,
  products,
  sources,
  saving,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  rule?: AssignmentRuleView | undefined;
  teams: TeamListItem[];
  products: { id: string; name: string }[];
  /** The tenant's own configured lead sources. */
  sources: string[];
  saving: boolean;
  error: unknown;
  onSubmit: (values: RuleFormValues) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const [values, setValues] = useState<RuleFormValues>(EMPTY);

  const dialog = useRef<HTMLDivElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;

    setValues(
      rule
        ? {
            name: rule.name,
            description: rule.description ?? '',
            priority: String(rule.priority),
            source: rule.source ?? '',
            productId: rule.product?.id ?? '',
            isFallback: rule.isFallback,
            targetTeamId: rule.targetTeam.id,
          }
        : EMPTY,
    );
  }, [open, rule]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    firstField.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialog.current?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href]',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      (opener.current as HTMLElement | null)?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const fieldError = (field: string): string | undefined =>
    error instanceof ApiError ? error.details?.[field]?.[0] : undefined;
  const message = error instanceof ApiError ? error.message : null;

  const set = <K extends keyof RuleFormValues>(key: K, value: RuleFormValues[K]): void =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit(values);
  };

  // Only teams that can actually receive work: the API refuses an archived
  // one, and offering it would produce an error nobody can act on.
  const targets = teams.filter(
    (team) => team.status === 'ACTIVE' || team.id === rule?.targetTeam.id,
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rule-form-title"
        className="mt-12 w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-lg"
      >
        <form onSubmit={submit}>
          <div className="border-b border-slate-100 px-5 py-3.5">
            <h2 id="rule-form-title" className="text-sm font-semibold text-slate-900">
              {rule ? 'Edit rule' : 'New routing rule'}
            </h2>
          </div>

          <div className="space-y-4 px-5 py-4">
            <div>
              <label htmlFor="rule-name" className="mb-1 block text-xs font-medium text-slate-600">
                Name
              </label>
              <input
                id="rule-name"
                ref={firstField}
                value={values.name}
                onChange={(event) => set('name', event.target.value)}
                required
                maxLength={80}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
              />
              {fieldError('name') && (
                <p className="mt-1 text-xs text-red-600">{fieldError('name')}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="rule-description"
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                Description <span className="text-slate-400">(optional)</span>
              </label>
              <textarea
                id="rule-description"
                value={values.description}
                onChange={(event) => set('description', event.target.value)}
                rows={2}
                maxLength={500}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
              />
            </div>

            <label className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={values.isFallback}
                onChange={(event) => set('isFallback', event.target.checked)}
                className="mt-0.5 rounded border-slate-300"
              />
              <span>
                <span className="font-medium text-slate-800">Use as the fallback</span>
                <br />
                Handles anything no other rule matched. One per organization, and it carries no
                criteria of its own.
              </span>
            </label>

            {!values.isFallback && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="rule-source"
                    className="mb-1 block text-xs font-medium text-slate-600"
                  >
                    Source <span className="text-slate-400">(any, if blank)</span>
                  </label>
                  <input
                    id="rule-source"
                    list="rule-source-options"
                    value={values.source}
                    onChange={(event) => set('source', event.target.value)}
                    maxLength={60}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
                  />
                  {/* The tenant's own configured sources, as suggestions
                      rather than a closed list: the list can change, and a
                      rule written ahead of one is legitimate. */}
                  <datalist id="rule-source-options">
                    {sources.map((source) => (
                      <option key={source} value={source} />
                    ))}
                  </datalist>
                </div>

                <div>
                  <label
                    htmlFor="rule-product"
                    className="mb-1 block text-xs font-medium text-slate-600"
                  >
                    Product <span className="text-slate-400">(any, if blank)</span>
                  </label>
                  <select
                    id="rule-product"
                    value={values.productId}
                    onChange={(event) => set('productId', event.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
                  >
                    <option value="">Any product</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="rule-team" className="mb-1 block text-xs font-medium text-slate-600">
                  Send to team
                </label>
                <select
                  id="rule-team"
                  value={values.targetTeamId}
                  onChange={(event) => set('targetTeamId', event.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
                >
                  <option value="">Choose a team…</option>
                  {targets.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
                {fieldError('targetTeamId') && (
                  <p className="mt-1 text-xs text-red-600">{fieldError('targetTeamId')}</p>
                )}
              </div>

              {!values.isFallback && (
                <div>
                  <label
                    htmlFor="rule-priority"
                    className="mb-1 block text-xs font-medium text-slate-600"
                  >
                    Priority <span className="text-slate-400">(lower runs first)</span>
                  </label>
                  <input
                    id="rule-priority"
                    type="number"
                    min={1}
                    max={100000}
                    value={values.priority}
                    onChange={(event) => set('priority', event.target.value)}
                    placeholder="Next free"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
                  />
                  {fieldError('priority') && (
                    <p className="mt-1 text-xs text-red-600">{fieldError('priority')}</p>
                  )}
                </div>
              )}
            </div>

            {message && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {message}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? 'Saving…' : rule ? 'Save changes' : 'Create rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const EMPTY: RuleFormValues = {
  name: '',
  description: '',
  priority: '',
  source: '',
  productId: '',
  isFallback: false,
  targetTeamId: '',
};
