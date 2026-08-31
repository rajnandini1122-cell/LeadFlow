import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../lib/api-client';
import { useActiveProducts } from '../products/use-products';
import {
  useCreateRepeatOpportunity,
  useRepeatOptions,
  type RepeatOptions,
} from './use-retention';

/**
 * Raising the next opportunity for a customer we already have.
 *
 * The workflow is deliberately short, and everything about the customer is
 * already known: no company re-entry, no contact re-entry, nothing that could
 * produce a second record for a business already on file.
 *
 * The one rule worth stating plainly: the previous won value is shown as
 * CONTEXT and is never written into the estimate unless the salesperson puts
 * it there. An estimate is a forecast about this deal; last quarter's price is
 * a fact about a different one, and quietly conflating them would destroy
 * forecast accuracy as a measure without anyone noticing.
 */
export function RepeatBusinessDialog({
  accountId,
  accountName,
  onClose,
}: {
  accountId: string;
  accountName: string;
  onClose: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const options = useRepeatOptions(accountId, true);
  const catalogue = useActiveProducts();
  const create = useCreateRepeatOpportunity();

  const [productId, setProductId] = useState('');
  const [contactId, setContactId] = useState('');
  const [productInterest, setProductInterest] = useState('');
  const [estimatedValue, setEstimatedValue] = useState('');
  const [nextFollowUpAt, setNextFollowUpAt] = useState(defaultFollowUp());
  const [failure, setFailure] = useState<string | null>(null);

  /*
   * One key per dialog opening, not per click.
   *
   * That is precisely what makes a double-click a REPLAY of the same request
   * rather than a second one — and what keeps a genuine second enquiry for the
   * same product possible, because reopening the dialog mints a new key.
   */
  const idempotencyKey = useMemo(
    () => `${accountId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    [accountId],
  );

  const previous = options.data?.products.find((row) => row.productId === productId) ?? null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setFailure(null);

    create.mutate(
      {
        accountId,
        idempotencyKey,
        ...(productId ? { productId } : {}),
        ...(contactId ? { contactId } : {}),
        ...(productInterest ? { productInterest } : {}),
        // Only what was actually typed. Never the previous won value.
        ...(estimatedValue ? { estimatedValue: Number(estimatedValue) } : {}),
        nextFollowUpAt: new Date(nextFollowUpAt).toISOString(),
      },
      {
        onSuccess: (result) => {
          onClose();
          navigate(`/leads/${result.leadId}`);
        },
        onError: (error) =>
          setFailure(
            error instanceof ApiError ? error.message : 'Could not create that opportunity.',
          ),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-900">Repeat business</h2>
        <p className="mt-1 text-sm text-slate-500">
          A new opportunity for <strong className="font-medium text-slate-700">{accountName}</strong>
          . Nothing about the customer is re-entered or duplicated.
        </p>

        <form onSubmit={submit} className="mt-4 space-y-4">
          <PreviousPurchases
            options={options.data}
            selected={productId}
            onSelect={setProductId}
            catalogue={catalogue.data?.items ?? []}
          />

          {options.data && options.data.contacts.length > 0 && (
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Contact</span>
              <select
                value={contactId}
                onChange={(event) => setContactId(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="">Nobody in particular</option>
                {options.data.contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                    {contact.mobile ? ` · ${contact.mobile}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              What they need
            </span>
            <input
              value={productInterest}
              onChange={(event) => setProductInterest(event.target.value)}
              placeholder="e.g. 500 kg monthly, same specification"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-400">
              A new note on a new opportunity. Nothing they told you before is changed.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Estimated value
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={estimatedValue}
              onChange={(event) => setEstimatedValue(event.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />

            {/*
              Context, offered explicitly rather than filled in silently. The
              salesperson decides whether last time's price is this time's
              forecast.
            */}
            {previous?.lastWonValue !== null && previous?.lastWonValue !== undefined && (
              <span className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                They last paid {formatMoney(previous.lastWonValue)}.
                <button
                  type="button"
                  onClick={() => setEstimatedValue(String(previous.lastWonValue))}
                  className="font-medium text-slate-700 underline"
                >
                  Use that figure
                </button>
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Next follow-up
            </span>
            <input
              type="datetime-local"
              value={nextFollowUpAt}
              onChange={(event) => setNextFollowUpAt(event.target.value)}
              required
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-400">
              Every open opportunity needs a next action — no lead left behind.
            </span>
          </label>

          {failure && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {failure}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending || !nextFollowUpAt}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {create.isPending ? 'Creating…' : 'Create opportunity'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * What they have bought before, and everything else you sell.
 *
 * Previous purchases come first because that is the likeliest next
 * conversation, but a different product is one click away — a customer buying
 * something new is expansion, and the workflow should not push against it.
 */
function PreviousPurchases({
  options,
  selected,
  onSelect,
  catalogue,
}: {
  options: RepeatOptions | undefined;
  selected: string;
  onSelect: (id: string) => void;
  catalogue: { id: string; name: string }[];
}): React.JSX.Element {
  const bought = options?.products ?? [];
  const boughtIds = new Set(bought.map((row) => row.productId));

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-slate-700">Product</span>

      {bought.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {bought.map((row) => (
            <li key={row.productId}>
              <button
                type="button"
                onClick={() => onSelect(row.productId)}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${
                  selected === row.productId
                    ? 'border-slate-900 bg-slate-50'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <span>
                  <span className="font-medium text-slate-900">{row.name}</span>
                  <span className="block text-xs text-slate-500">
                    {row.wins} win{row.wins === 1 ? '' : 's'}
                    {row.lastWonAt
                      ? ` · last ${new Date(row.lastWonAt).toLocaleDateString()}`
                      : ''}
                  </span>
                </span>
                {row.lastWonValue !== null && (
                  <span className="shrink-0 text-xs tabular-nums text-slate-500">
                    {formatMoney(row.lastWonValue)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <select
        value={boughtIds.has(selected) ? '' : selected}
        onChange={(event) => onSelect(event.target.value)}
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      >
        <option value="">
          {bought.length > 0 ? 'Or something different…' : 'Choose a product…'}
        </option>
        {catalogue
          .filter((product) => !boughtIds.has(product.id))
          .map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
      </select>
    </div>
  );
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

/** Tomorrow morning — a sensible default nobody has to think about. */
function defaultFollowUp(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  date.setHours(10, 0, 0, 0);

  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
