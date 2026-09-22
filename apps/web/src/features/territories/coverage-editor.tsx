import { useState, type FormEvent } from 'react';
import {
  TERRITORY_COVERAGE_TYPES,
  type TerritoryCoverageType,
  type TerritoryDetail,
} from '@leadflow/api-types';
import { ApiError } from '../../lib/api-client';
import { countryOptions, DEFAULT_COUNTRY } from '../../lib/countries';
import { useAddCoverage, useRemoveCoverage, useTerritory } from './use-territories';

/**
 * The places one territory covers.
 *
 * A list and a small form, no map. What routes an enquiry is an exact
 * selector an administrator chose, so the screen shows exactly those — a map
 * would imply a precision the routing does not have, and drawing on one would
 * invent boundaries nobody configured.
 */
export function CoverageEditor({
  territoryId,
  canManage,
}: {
  territoryId: string;
  canManage: boolean;
}): React.JSX.Element {
  const detail = useTerritory(territoryId);
  const addCoverage = useAddCoverage();
  const removeCoverage = useRemoveCoverage();

  if (detail.isPending) {
    return <p className="px-5 py-4 text-xs text-slate-500">Loading coverage…</p>;
  }

  if (detail.isError || !detail.data) {
    return (
      <p role="alert" className="px-5 py-4 text-xs text-red-600">
        The coverage for this territory could not be loaded.
      </p>
    );
  }

  return (
    <div className="space-y-4 px-5 py-4">
      <CoverageList
        territory={detail.data}
        canManage={canManage}
        removing={removeCoverage.isPending}
        onRemove={(coverageId) => removeCoverage.mutate({ territoryId, coverageId })}
      />

      {canManage && detail.data.status === 'ACTIVE' && (
        <AddCoverageForm
          territoryId={territoryId}
          saving={addCoverage.isPending}
          error={addCoverage.error}
          onAdd={(body) => addCoverage.mutate({ territoryId, ...body }, { onSuccess: () => addCoverage.reset() })}
        />
      )}
    </div>
  );
}

function CoverageList({
  territory,
  canManage,
  removing,
  onRemove,
}: {
  territory: TerritoryDetail;
  canManage: boolean;
  removing: boolean;
  onRemove: (coverageId: string) => void;
}): React.JSX.Element {
  if (territory.coverage.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        No places yet. Until one is added, nothing resolves to this territory.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-slate-100">
      {territory.coverage.map((area) => (
        <li key={area.id} className="flex items-center justify-between gap-3 py-2">
          <span className="flex items-center gap-2 text-sm">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
              {TYPE_LABELS[area.type]}
            </span>
            <span className="text-slate-800">{area.label}</span>
          </span>

          {canManage && territory.status === 'ACTIVE' && (
            <button
              type="button"
              disabled={removing}
              onClick={() => onRemove(area.id)}
              className="text-xs text-slate-500 hover:text-red-600 disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Add one place.
 *
 * The type is chosen explicitly rather than inferred from which boxes are
 * filled. "IN + Maharashtra + Pune" is either a city qualified by its state or
 * a state with a stray city in it, and those route different enquiries — so
 * the administrator says which they mean rather than the form guessing.
 */
function AddCoverageForm({
  territoryId,
  saving,
  error,
  onAdd,
}: {
  territoryId: string;
  saving: boolean;
  error: unknown;
  onAdd: (body: {
    type: TerritoryCoverageType;
    country: string;
    state?: string;
    city?: string;
    postalCode?: string;
  }) => void;
}): React.JSX.Element {
  const [type, setType] = useState<TerritoryCoverageType>('CITY');
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');

  const countries = countryOptions();
  const message = error instanceof ApiError ? error.message : null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    onAdd({
      type,
      country,
      // Only the fields this selector type uses. Sending the others would be
      // refused, and clearing them silently would hide a mistake.
      ...(type === 'STATE' || (type === 'CITY' && state) ? { state } : {}),
      ...(type === 'CITY' ? { city } : {}),
      ...(type === 'POSTAL_CODE' ? { postalCode } : {}),
    });

    setState('');
    setCity('');
    setPostalCode('');
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Add coverage"
      className="flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 px-3 py-3"
    >
      <div>
        <label
          htmlFor={`coverage-type-${territoryId}`}
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          Covers
        </label>
        <select
          id={`coverage-type-${territoryId}`}
          value={type}
          onChange={(event) => setType(event.target.value as TerritoryCoverageType)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
        >
          {TERRITORY_COVERAGE_TYPES.map((option) => (
            <option key={option} value={option}>
              {TYPE_LABELS[option]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor={`coverage-country-${territoryId}`}
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          Country
        </label>
        <select
          id={`coverage-country-${territoryId}`}
          value={country}
          onChange={(event) => setCountry(event.target.value)}
          required
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
        >
          {countries.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      {(type === 'STATE' || type === 'CITY') && (
        <div>
          <label
            htmlFor={`coverage-state-${territoryId}`}
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            State {type === 'CITY' && <span className="text-slate-400">(optional)</span>}
          </label>
          <input
            id={`coverage-state-${territoryId}`}
            value={state}
            onChange={(event) => setState(event.target.value)}
            required={type === 'STATE'}
            maxLength={80}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>
      )}

      {type === 'CITY' && (
        <div>
          <label
            htmlFor={`coverage-city-${territoryId}`}
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            City
          </label>
          <input
            id={`coverage-city-${territoryId}`}
            value={city}
            onChange={(event) => setCity(event.target.value)}
            required
            maxLength={80}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>
      )}

      {type === 'POSTAL_CODE' && (
        <div>
          <label
            htmlFor={`coverage-postal-${territoryId}`}
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Postal code
          </label>
          <input
            id={`coverage-postal-${territoryId}`}
            value={postalCode}
            onChange={(event) => setPostalCode(event.target.value)}
            required
            maxLength={16}
            placeholder="411019"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>
      )}

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {saving ? 'Adding…' : 'Add'}
      </button>

      {message && (
        <p role="alert" className="w-full text-xs text-red-600">
          {message}
        </p>
      )}
    </form>
  );
}

const TYPE_LABELS: Record<TerritoryCoverageType, string> = {
  COUNTRY: 'Country',
  STATE: 'State',
  CITY: 'City',
  POSTAL_CODE: 'Postal code',
};
