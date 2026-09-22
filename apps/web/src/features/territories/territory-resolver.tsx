import { useState, type FormEvent } from 'react';
import { Card, CardHeader } from '../../components/ui';
import { countryOptions, DEFAULT_COUNTRY } from '../../lib/countries';
import { useResolveTerritory } from './use-territories';

/**
 * "Where would this address go?"
 *
 * Read-only, and the screen says so. An administrator about to redraw the map
 * should be able to check it without wondering whether checking it changed
 * anything — nothing here creates a lead, touches an enquiry, or edits a
 * single coverage row.
 */
export function TerritoryResolver(): React.JSX.Element {
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const resolve = useResolveTerritory();

  const countries = countryOptions();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    resolve.mutate({
      country,
      ...(state ? { state } : {}),
      ...(city ? { city } : {}),
      ...(postalCode ? { postalCode } : {}),
    });
  };

  return (
    <Card>
      <CardHeader
        title="Test a location"
        subtitle="Nothing is created or changed — this only reports which territory an address falls in."
      />

      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 px-5 py-4">
        <div>
          <label
            htmlFor="resolve-country"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Country
          </label>
          <select
            id="resolve-country"
            value={country}
            onChange={(event) => setCountry(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          >
            {countries.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="resolve-state" className="mb-1 block text-xs font-medium text-slate-600">
            State
          </label>
          <input
            id="resolve-state"
            value={state}
            onChange={(event) => setState(event.target.value)}
            placeholder="Any"
            maxLength={80}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>

        <div>
          <label htmlFor="resolve-city" className="mb-1 block text-xs font-medium text-slate-600">
            City
          </label>
          <input
            id="resolve-city"
            value={city}
            onChange={(event) => setCity(event.target.value)}
            placeholder="Any"
            maxLength={80}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>

        <div>
          <label htmlFor="resolve-postal" className="mb-1 block text-xs font-medium text-slate-600">
            Postal code
          </label>
          <input
            id="resolve-postal"
            value={postalCode}
            onChange={(event) => setPostalCode(event.target.value)}
            placeholder="Any"
            maxLength={16}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>

        <button
          type="submit"
          disabled={resolve.isPending}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {resolve.isPending ? 'Checking…' : 'Check'}
        </button>
      </form>

      {resolve.isError && (
        <p role="alert" className="px-5 pb-4 text-xs text-red-600">
          The location could not be resolved. Please try again.
        </p>
      )}

      {resolve.data && (
        <div className="border-t border-slate-100 px-5 py-4 text-sm" data-testid="resolve-result">
          {resolve.data.decision === 'MATCHED' && resolve.data.territory ? (
            <>
              <p className="text-slate-700">
                Resolves to{' '}
                <span className="font-medium text-slate-900">{resolve.data.territory.name}</span>
              </p>
              {resolve.data.matchedCoverage && (
                <p className="mt-1 text-xs text-slate-500">
                  {/* WHICH selector answered, not just that one did: an
                      administrator checking why an enquiry went somewhere
                      needs to know whether it was the pincode or the country
                      that decided. */}
                  Matched on {TYPE_LABELS[resolve.data.matchedCoverage.type]} —{' '}
                  {resolve.data.matchedCoverage.label}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-slate-700">No territory covers this location.</p>
              <p className="mt-1 text-xs text-slate-500">
                Add a country, state, city or postal code above to one of your territories.
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

const TYPE_LABELS: Record<string, string> = {
  COUNTRY: 'country',
  STATE: 'state',
  CITY: 'city',
  POSTAL_CODE: 'postal code',
};
