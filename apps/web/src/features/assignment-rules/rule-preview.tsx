import { useState, type FormEvent } from 'react';
import { Card, CardHeader } from '../../components/ui';
import { countryOptions } from '../../lib/countries';
import { usePreviewAssignment } from './use-assignment-rules';

/**
 * "Where would this go?"
 *
 * Read-only, and the screen says so — an administrator about to change how
 * customers are routed should be able to check the table without wondering
 * whether checking it did something. Nothing here creates a lead, touches an
 * enquiry or picks a person.
 */
export function RulePreview({
  sources,
  products,
}: {
  sources: string[];
  products: { id: string; name: string }[];
}): React.JSX.Element {
  const [source, setSource] = useState('');
  const [productId, setProductId] = useState('');
  const [country, setCountry] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const preview = usePreviewAssignment();

  const countries = countryOptions();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    /*
     * Geography goes up RAW, and the server resolves it to a territory before
     * it evaluates anything — the same path the phase that converts an enquiry
     * into a lead will take. Resolving it here instead would mean the screen
     * tested one thing and production did another.
     */
    preview.mutate({
      ...(source ? { source } : {}),
      ...(productId ? { productId } : {}),
      ...(country ? { country } : {}),
      ...(state ? { state } : {}),
      ...(city ? { city } : {}),
      ...(postalCode ? { postalCode } : {}),
    });
  };

  return (
    <Card>
      <CardHeader
        title="Test a rule"
        subtitle="Nothing is created or changed — this only reports what the rules would decide."
      />

      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 px-5 py-4">
        <div>
          <label htmlFor="preview-source" className="mb-1 block text-xs font-medium text-slate-600">
            Source
          </label>
          <input
            id="preview-source"
            list="preview-source-options"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="Any"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
          <datalist id="preview-source-options">
            {sources.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </div>

        <div>
          <label
            htmlFor="preview-product"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Product
          </label>
          <select
            id="preview-product"
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          >
            <option value="">Any</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="preview-country"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Country
          </label>
          <select
            id="preview-country"
            value={country}
            onChange={(event) => setCountry(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          >
            <option value="">Any</option>
            {countries.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="preview-state" className="mb-1 block text-xs font-medium text-slate-600">
            State
          </label>
          <input
            id="preview-state"
            value={state}
            onChange={(event) => setState(event.target.value)}
            placeholder="Any"
            maxLength={80}
            className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>

        <div>
          <label htmlFor="preview-city" className="mb-1 block text-xs font-medium text-slate-600">
            City
          </label>
          <input
            id="preview-city"
            value={city}
            onChange={(event) => setCity(event.target.value)}
            placeholder="Any"
            maxLength={80}
            className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>

        <div>
          <label
            htmlFor="preview-postal"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Postal code
          </label>
          <input
            id="preview-postal"
            value={postalCode}
            onChange={(event) => setPostalCode(event.target.value)}
            placeholder="Any"
            maxLength={16}
            className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>

        <button
          type="submit"
          disabled={preview.isPending}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {preview.isPending ? 'Checking…' : 'Check'}
        </button>
      </form>

      {preview.isError && (
        <p role="alert" className="px-5 pb-4 text-xs text-red-600">
          The rules could not be evaluated. Please try again.
        </p>
      )}

      {preview.data && (
        <div className="border-t border-slate-100 px-5 py-4 text-sm" data-testid="preview-result">
          <Outcome decision={preview.data.decision} />

          {/*
            What the geography resolved to, shown whether or not a rule went on
            to mention it. "No rule matched" and "that pincode is on nobody's
            map" are different problems with different fixes, and an
            administrator who cannot tell them apart fixes the wrong one.
          */}
          {(country || state || city || postalCode) && (
            <p className="mt-2 text-slate-600">
              {preview.data.territory ? (
                <>
                  Territory{' '}
                  <span className="font-medium text-slate-900">
                    {preview.data.territory.name}
                  </span>
                </>
              ) : (
                <span className="text-slate-500">
                  No territory covers that location, so no territory rule can match it.
                </span>
              )}
            </p>
          )}

          {preview.data.rule && (
            <p className="mt-2 text-slate-600">
              Matched <span className="font-medium text-slate-900">{preview.data.rule.name}</span>
              {preview.data.rule.isFallback ? ' (the fallback)' : null} → team{' '}
              <span className="font-medium text-slate-900">{preview.data.team?.name}</span>
            </p>
          )}

          {preview.data.team && (
            <p className="mt-1 text-xs text-slate-500">
              {preview.data.eligibleAgentCount === 0
                ? // Names the team rather than repeating the sentence above
                  // it: an administrator needs to know WHERE to go and add
                  // somebody, and one panel saying the same thing twice reads
                  // like a mistake.
                  `No agents available in ${preview.data.team.name}.`
                : `${preview.data.eligibleAgentCount} ${
                    preview.data.eligibleAgentCount === 1 ? 'agent' : 'agents'
                  } available: ${preview.data.eligibleAgents
                    .map((agent) => agent.fullName)
                    .join(', ')}`}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * The decision, said plainly.
 *
 * Four outcomes, and the differences matter: falling through to the fallback
 * usually means a rule is missing, and a matched rule with nobody available is
 * a staffing problem rather than a routing one. A single "no result" would
 * hide both.
 */
function Outcome({ decision }: { decision: string }): React.JSX.Element {
  const copy: Record<string, { label: string; tone: string; detail: string }> = {
    MATCHED: {
      label: 'Matched',
      tone: 'bg-emerald-50 text-emerald-700',
      detail: 'A specific rule handles this.',
    },
    FALLBACK_MATCHED: {
      label: 'Fallback',
      tone: 'bg-amber-50 text-amber-700',
      detail: 'No specific rule matched, so the fallback would take it.',
    },
    NO_MATCH: {
      label: 'No match',
      tone: 'bg-slate-100 text-slate-600',
      detail: 'No rule matches this, and there is no fallback. Nothing would be routed.',
    },
    NO_ELIGIBLE_AGENTS: {
      label: 'No available agents',
      tone: 'bg-red-50 text-red-700',
      detail: 'A rule matched, but nobody in that team can receive work right now.',
    },
  };

  const outcome = copy[decision] ?? copy['NO_MATCH'];

  return (
    <div className="flex items-center gap-2">
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${outcome?.tone}`}>
        {outcome?.label}
      </span>
      <span className="text-xs text-slate-500">{outcome?.detail}</span>
    </div>
  );
}
