import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api-client';

/**
 * Product master and product intelligence.
 *
 * A KPI that cannot be calculated comes back as NULL from the server, never as
 * zero — "nothing has closed yet" and "we won none of them" are different
 * facts. Every type below reflects that, and the UI renders an em dash rather
 * than inventing a figure.
 */

export interface Product {
  id: string;
  name: string;
  sku: string;
  category: string | null;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductPage {
  items: Product[];
  total: number;
  limit: number;
  offset: number;
}

export type TrendDirection = 'rising' | 'falling' | 'stable' | 'new' | 'insufficient';

export interface ProductTrend {
  current: number;
  previous: number;
  /** Null when the sample is too small, or there is no previous period. */
  change: number | null;
  direction: TrendDirection;
}

export interface ProductPerformanceRow {
  productId: string;
  name: string;
  sku: string | null;
  category: string | null;
  active: boolean;

  totalLeads: number;
  demandShare: number | null;

  openLeads: number;
  openPipeline: number | null;

  wonLeads: number;
  wonValue: number | null;
  lostLeads: number;
  lostValue: number | null;

  winRate: number | null;
  /** False when too few deals have closed for a percentage to mean anything. */
  winRateReliable: boolean;

  averageWonValue: number | null;
  averageDaysToClose: number | null;

  forecast: {
    estimated: number | null;
    actual: number | null;
    variance: number | null;
    accuracy: number | null;
  };

  trend: ProductTrend | null;
}

export interface ProductPerformance {
  items: ProductPerformanceRow[];
  totals: {
    productsWithDemand: number;
    leadsWithProduct: number;
    /**
     * Shown prominently, not hidden.
     *
     * Every other figure covers only leads that HAVE a product. Without this,
     * a dashboard built on a fraction of the data looks like it covers all of
     * it.
     */
    leadsWithoutProduct: number;
  };
}

export function useProducts(filters: {
  search?: string;
  category?: string;
  active?: boolean | undefined;
  limit?: number;
  offset?: number;
}): UseQueryResult<ProductPage> {
  const params: Record<string, unknown> = {};
  if (filters.search) params['search'] = filters.search;
  if (filters.category) params['category'] = filters.category;
  if (filters.active !== undefined) params['active'] = filters.active;
  if (filters.limit) params['limit'] = filters.limit;
  if (filters.offset) params['offset'] = filters.offset;

  return useQuery({
    queryKey: ['products', params],
    queryFn: () => apiGet<ProductPage>('/products', params),
  });
}

/**
 * The catalogue for a picker.
 *
 * Active products only: a retired product should not be offered on a NEW lead,
 * even though it stays in every historical report.
 */
export function useActiveProducts(): UseQueryResult<ProductPage> {
  return useQuery({
    queryKey: ['products', { active: true, forPicker: true }],
    queryFn: () => apiGet<ProductPage>('/products', { active: true, limit: 200 }),
    staleTime: 5 * 60 * 1000,
  });
}

export function useProductCategories(): UseQueryResult<{ categories: string[] }> {
  return useQuery({
    queryKey: ['products', 'categories'],
    queryFn: () => apiGet<{ categories: string[] }>('/products/categories'),
    staleTime: 5 * 60 * 1000,
  });
}

/** Invalidates everything a catalogue write can affect, including the KPIs. */
function useProductMutation<TArgs>(
  request: (args: TArgs) => Promise<unknown>,
): UseMutationResult<unknown, Error, TArgs> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      // Renaming or retiring a product changes what the dashboard says.
      void queryClient.invalidateQueries({ queryKey: ['product-kpi'] });
    },
  });
}

export function useCreateProduct() {
  return useProductMutation((input: {
    name: string;
    sku: string;
    category?: string;
    description?: string;
    active?: boolean;
  }) => apiPost<Product>('/products', input));
}

export function useUpdateProduct() {
  return useProductMutation(
    ({ id, ...input }: { id: string } & Partial<Omit<Product, 'id'>>) =>
      apiPatch<Product>(`/products/${id}`, input),
  );
}

/**
 * Retires a product.
 *
 * Deletes it only if it has never been used; otherwise deactivates. The
 * response says which happened, so the UI can tell the truth about it.
 */
export function useDeactivateProduct(): UseMutationResult<
  { deleted: boolean; deactivated: boolean; leadCount: number },
  Error,
  string
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/products/${id}`) as unknown as Promise<{
        deleted: boolean;
        deactivated: boolean;
        leadCount: number;
      }>,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['product-kpi'] });
    },
  });
}

// --- intelligence ------------------------------------------------------------

export function useProductPerformance(range?: string): UseQueryResult<ProductPerformance> {
  const params = range ? { preset: range } : {};

  return useQuery({
    queryKey: ['product-kpi', 'performance', range ?? 'all'],
    queryFn: () => apiGet<ProductPerformance>('/products/kpi/performance', params),
  });
}

export interface TrendSeries {
  series: { productId: string; name: string; points: { date: string; count: number }[] }[];
}

export function useProductTrend(range: string): UseQueryResult<TrendSeries> {
  return useQuery({
    queryKey: ['product-kpi', 'trend', range],
    queryFn: () => apiGet<TrendSeries>('/products/kpi/trend', { preset: range }),
  });
}

export interface ProductBySource {
  sources: string[];
  items: {
    productId: string;
    name: string;
    counts: Record<string, number>;
    total: number;
  }[];
}

export function useProductBySource(): UseQueryResult<ProductBySource> {
  return useQuery({
    queryKey: ['product-kpi', 'by-source'],
    queryFn: () => apiGet<ProductBySource>('/products/kpi/by-source'),
  });
}

export interface ProductByAgent {
  items: {
    productId: string;
    productName: string;
    agentId: string | null;
    agentName: string;
    leads: number;
    openPipeline: number;
    wonDeals: number;
    wonValue: number;
    winRate: number | null;
    winRateReliable: boolean;
  }[];
}

export function useProductByAgent(): UseQueryResult<ProductByAgent> {
  return useQuery({
    queryKey: ['product-kpi', 'by-agent'],
    queryFn: () => apiGet<ProductByAgent>('/products/kpi/by-agent'),
  });
}

export interface ProductLossAnalysis {
  items: {
    productId: string;
    name: string;
    lostLeads: number;
    lostValue: number;
    reasons: { reason: string; count: number; value: number | null }[];
  }[];
}

export function useProductLossAnalysis(): UseQueryResult<ProductLossAnalysis> {
  return useQuery({
    queryKey: ['product-kpi', 'loss-analysis'],
    queryFn: () => apiGet<ProductLossAnalysis>('/products/kpi/loss-analysis'),
  });
}

// --- backfill ----------------------------------------------------------------

export interface MappingProgress {
  mapped: number;
  unmapped: number;
  total: number;
  /** Null for an organization with no leads at all, rather than 100%. */
  percentMapped: number | null;
}

export function useMappingProgress(): UseQueryResult<MappingProgress> {
  return useQuery({
    queryKey: ['products', 'mapping', 'progress'],
    queryFn: () => apiGet<MappingProgress>('/products/mapping/progress'),
  });
}

export interface UnmappedLead {
  id: string;
  leadNumber: string;
  name: string;
  companyName: string | null;
  productInterest: string | null;
  status: string;
  createdAt: string;
}

export function useUnmappedLeads(
  search: string,
  enabled: boolean,
): UseQueryResult<{ items: UnmappedLead[]; total: number; returned: number }> {
  return useQuery({
    queryKey: ['products', 'mapping', 'unmapped', search],
    queryFn: () =>
      apiGet<{ items: UnmappedLead[]; total: number; returned: number }>(
        '/products/mapping/unmapped',
        search ? { search, limit: 100 } : { limit: 100 },
      ),
    enabled,
  });
}

export function useAssignProduct(): UseMutationResult<
  { updated: number },
  Error,
  { productId: string; leadIds: string[] }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input) => apiPost<{ updated: number }>('/products/mapping/assign', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['product-kpi'] });
      // Mapping changes which product a lead belongs to.
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}

// --- presentation helpers ----------------------------------------------------

/**
 * A KPI, or an em dash.
 *
 * The single most important formatter here. Every one of these figures can
 * legitimately be null, and printing "0" or "0%" in those cases states
 * something false about a product.
 */
export function formatKpi(
  value: number | null | undefined,
  kind: 'number' | 'percent' | 'days' = 'number',
): string {
  if (value === null || value === undefined) return '—';

  if (kind === 'percent') return `${Math.round(value * 1000) / 10}%`;
  if (kind === 'days') return `${value} days`;
  return new Intl.NumberFormat().format(value);
}

export const TREND_PRESENTATION: Record<TrendDirection, { icon: string; tone: string }> = {
  rising: { icon: '▲', tone: 'text-emerald-600' },
  falling: { icon: '▼', tone: 'text-red-600' },
  stable: { icon: '→', tone: 'text-slate-400' },
  new: { icon: '✦', tone: 'text-sky-600' },
  insufficient: { icon: '·', tone: 'text-slate-300' },
};
