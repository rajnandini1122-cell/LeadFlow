import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../lib/api-client';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import {
  useActiveProducts,
  useAssignProduct,
  useMappingProgress,
  useUnmappedLeads,
} from './use-products';

/**
 * Classifying leads that predate the catalogue.
 *
 * The whole screen exists because NOTHING IS GUESSED. Historical leads carry
 * free text like "White onion powder 25kg requirement", and a substring rule
 * would file "onion storage crates" under White Onion Powder. A wrong mapping
 * produces a confident KPI that is quietly false, and nobody finds out until
 * the number is quoted in a meeting — so a person reads the enquiry and
 * chooses.
 *
 * The free text is never overwritten. The product is a grouping key placed
 * beside it, not a replacement for it.
 */
export function ProductMappingPage(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [productId, setProductId] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const progress = useMappingProgress();
  const products = useActiveProducts();
  const leads = useUnmappedLeads(search, true);
  const assign = useAssignProduct();

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const apply = (): void => {
    if (!productId || selected.size === 0) return;

    setFailure(null);
    setResult(null);

    assign.mutate(
      { productId, leadIds: [...selected] },
      {
        onSuccess: (response) => {
          setResult(
            `${response.updated} lead${response.updated === 1 ? '' : 's'} mapped. Their enquiry text is unchanged.`,
          );
          setSelected(new Set());
        },
        onError: (error) =>
          setFailure(error instanceof ApiError ? error.message : 'Could not map those leads.'),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Map leads to products"
        subtitle="Classify historical enquiries so they appear in product figures."
        action={
          <Link
            to="/products"
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Back to catalogue
          </Link>
        }
      />

      {progress.data && (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
          <span className="text-slate-600">
            <strong className="font-medium text-slate-900">{progress.data.mapped}</strong> mapped
          </span>
          <span className="text-slate-600">
            <strong className="font-medium text-slate-900">{progress.data.unmapped}</strong>{' '}
            remaining
          </span>
          {progress.data.percentMapped !== null && (
            <span className="text-slate-500">{progress.data.percentMapped}% classified</span>
          )}
        </div>
      )}

      <Card>
        <CardHeader
          title="Unmapped leads"
          subtitle="Read the enquiry, then choose the product it belongs to."
        />

        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search enquiry text…"
            className="min-w-48 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />

          <select
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="">Choose a product…</option>
            {(products.data?.items ?? []).map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={apply}
            disabled={!productId || selected.size === 0 || assign.isPending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {assign.isPending ? 'Mapping…' : `Map ${selected.size || ''} selected`}
          </button>
        </div>

        {failure && (
          <p role="alert" className="mx-4 mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {failure}
          </p>
        )}

        {result && (
          <p
            role="status"
            className="mx-4 mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          >
            {result}
          </p>
        )}

        {leads.isPending ? (
          <SkeletonRows rows={5} />
        ) : leads.isError ? (
          <ErrorNotice message="Could not load unmapped leads." />
        ) : leads.data.items.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">
            {search ? 'Nothing matches that.' : 'Every lead has a product. Nothing to map.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="w-10 px-4 py-2.5" />
                  <th className="px-4 py-2.5 font-medium">Lead</th>
                  <th className="px-4 py-2.5 font-medium">What they asked for</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {leads.data.items.map((lead) => (
                  <tr
                    key={lead.id}
                    className={selected.has(lead.id) ? 'bg-slate-50' : ''}
                    onClick={() => toggle(lead.id)}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => toggle(lead.id)}
                        aria-label={`Select ${lead.leadNumber}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-slate-900">{lead.name}</span>
                      <p className="text-xs text-slate-500">
                        {lead.leadNumber}
                        {lead.companyName ? ` · ${lead.companyName}` : ''}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-pretty text-slate-700">
                      {/*
                        The evidence. This is what the person reads to decide,
                        and it is never overwritten by the mapping.
                      */}
                      {lead.productInterest ?? (
                        <span className="text-slate-400">Nothing recorded</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{lead.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {leads.data && leads.data.total > leads.data.returned && (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Showing {leads.data.returned} of {leads.data.total}. Map these, or search to narrow
            the list.
          </p>
        )}
      </Card>
    </>
  );
}
