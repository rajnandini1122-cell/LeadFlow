import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../lib/api-client';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { PERMISSIONS } from '@leadflow/api-types';
import {
  formatKpi,
  useCreateProduct,
  useDeactivateProduct,
  useMappingProgress,
  useProductCategories,
  useProductPerformance,
  useProducts,
  useUpdateProduct,
  type Product,
} from './use-products';

/**
 * The product catalogue.
 *
 * Lists what the organization sells, with the demand each product has actually
 * attracted. The KPI columns come from the performance endpoint and are joined
 * by id here, so a product with no leads shows dashes rather than zeroes — it
 * has no demand data, which is not the same as no demand.
 */
export function ProductsPage(): React.JSX.Element {
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.ORG_UPDATE);
  const canSeeKpis = can(PERMISSIONS.REPORT_VIEW);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);

  const products = useProducts({
    ...(search ? { search } : {}),
    ...(category ? { category } : {}),
    ...(showInactive ? {} : { active: true }),
    limit: 200,
  });
  const categories = useProductCategories();
  const progress = useMappingProgress();

  // Only fetched for roles that may see reporting figures.
  const performance = useProductPerformance();
  const kpiById = new Map(
    (canSeeKpis ? (performance.data?.items ?? []) : []).map((row) => [row.productId, row]),
  );

  return (
    <>
      <PageHeader
        title="Products"
        subtitle="What you sell, and what customers are actually asking for."
        action={
          canManage ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              + New product
            </button>
          ) : undefined
        }
      />

      {/*
        The backfill prompt.
        Every KPI covers only leads that have a product, so a large unmapped
        backlog means the numbers describe a fraction of the business. Saying so
        here is more honest than a dashboard that looks complete.
      */}
      {canManage && progress.data && progress.data.unmapped > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-pretty text-amber-900">
            <strong className="font-medium">
              {formatKpi(progress.data.unmapped)} leads have no product yet.
            </strong>{' '}
            Product figures below cover only the {formatKpi(progress.data.mapped)} that do.
          </p>
          <Link
            to="/products/mapping"
            className="shrink-0 rounded-lg bg-amber-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-800"
          >
            Map them
          </Link>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or SKU…"
            className="min-w-48 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />

          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="">All categories</option>
            {(categories.data?.categories ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
            />
            Include retired
          </label>
        </div>

        {products.isPending ? (
          <SkeletonRows rows={5} />
        ) : products.isError ? (
          <ErrorNotice message="Could not load the catalogue." />
        ) : products.data.items.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">
            {search || category
              ? 'No products match that.'
              : 'No products yet. Add what you sell, then leads can be grouped by it.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Product</th>
                  <th className="px-4 py-2.5 font-medium">SKU</th>
                  <th className="px-4 py-2.5 font-medium">Category</th>
                  {canSeeKpis && (
                    <>
                      <th className="px-4 py-2.5 text-right font-medium">Leads</th>
                      <th className="px-4 py-2.5 text-right font-medium">Open pipeline</th>
                      <th className="px-4 py-2.5 text-right font-medium">Won</th>
                      <th className="px-4 py-2.5 text-right font-medium">Win rate</th>
                    </>
                  )}
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  {canManage && <th className="px-4 py-2.5" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {products.data.items.map((product) => {
                  const kpi = kpiById.get(product.id);

                  return (
                    <tr key={product.id} className={product.active ? '' : 'bg-slate-50/60'}>
                      <td className="px-4 py-3">
                        <Link
                          to={`/leads?productId=${product.id}`}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {product.name}
                        </Link>
                        {product.description && (
                          <p className="mt-0.5 max-w-md truncate text-xs text-slate-500">
                            {product.description}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{product.sku}</td>
                      <td className="px-4 py-3 text-slate-600">{product.category ?? '—'}</td>

                      {canSeeKpis && (
                        <>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {formatKpi(kpi?.totalLeads ?? 0)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {formatKpi(kpi?.openPipeline)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {formatKpi(kpi?.wonValue)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {/*
                              A rate off one or two deals is withheld and the
                              counts shown instead — "100%" from a single sale
                              tells nobody anything.
                            */}
                            {kpi && kpi.winRate !== null && kpi.winRateReliable
                              ? formatKpi(kpi.winRate, 'percent')
                              : kpi && kpi.wonLeads + kpi.lostLeads > 0
                                ? `${kpi.wonLeads}/${kpi.wonLeads + kpi.lostLeads}`
                                : '—'}
                          </td>
                        </>
                      )}

                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            product.active
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {product.active ? 'Active' : 'Retired'}
                        </span>
                      </td>

                      {canManage && (
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setEditing(product)}
                            className="rounded-lg px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
                          >
                            Edit
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(creating || editing) && (
        <ProductDialog
          product={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Create or edit one product.
 *
 * Renaming is allowed even on a product with history: leads reference the id,
 * so nothing moves between products and no historical figure changes. That is
 * the whole reason the catalogue is a table rather than a string on the lead.
 */
function ProductDialog({
  product,
  onClose,
}: {
  product: Product | null;
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const deactivate = useDeactivateProduct();

  const [name, setName] = useState(product?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [active, setActive] = useState(product?.active ?? true);
  const [failure, setFailure] = useState<string | null>(null);
  const [retireResult, setRetireResult] = useState<string | null>(null);

  const busy = create.isPending || update.isPending || deactivate.isPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setFailure(null);

    const payload = {
      name: name.trim(),
      sku: sku.trim(),
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      active,
    };

    const onError = (error: unknown): void =>
      setFailure(
        error instanceof ApiError ? error.message : 'Could not save the product.',
      );

    if (product) {
      update.mutate({ id: product.id, ...payload }, { onSuccess: onClose, onError });
    } else {
      create.mutate(payload, { onSuccess: onClose, onError });
    }
  };

  const retire = (): void => {
    if (!product) return;
    setFailure(null);

    deactivate.mutate(product.id, {
      onSuccess: (result) => {
        if (result.deleted) {
          onClose();
          return;
        }
        // Deactivated rather than deleted, and the user should know why.
        setRetireResult(
          `Retired. It stays in reporting because ${result.leadCount} lead${
            result.leadCount === 1 ? '' : 's'
          } reference it.`,
        );
      },
      onError: () => setFailure('Could not retire the product.'),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <CardHeader title={product ? 'Edit product' : 'New product'} />

        <form onSubmit={submit} className="space-y-4 p-5">
          <Field label="Product name" required>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              minLength={2}
              autoFocus
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </Field>

          <Field
            label="SKU"
            required
            hint="Your own code for it. Unique within your organization, and uppercased."
          >
            <input
              value={sku}
              onChange={(event) => setSku(event.target.value)}
              required
              className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm uppercase"
            />
          </Field>

          <Field label="Category">
            <input
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="e.g. Powders"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </Field>

          <Field label="Description">
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </Field>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
            />
            Offered on new leads
          </label>

          {failure && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {failure}
            </p>
          )}

          {retireResult && (
            <p role="status" className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">
              {retireResult}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
            <button
              type="submit"
              disabled={busy || name.trim().length < 2 || sku.trim().length === 0}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? 'Saving…' : product ? 'Save changes' : 'Create product'}
            </button>

            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancel
            </button>

            {product && (
              <button
                type="button"
                onClick={retire}
                disabled={busy}
                className="ml-auto rounded-lg px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50"
              >
                Retire
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
