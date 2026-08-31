import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../../lib/api-client';

/**
 * Customers, Customer 360, and customer KPIs.
 *
 * A KPI that cannot be calculated comes back as NULL from the server, never as
 * zero — "no customer has bought twice yet" and "the repeat rate is 0%"
 * describe completely different businesses. Every type below reflects that, and
 * the UI renders an em dash rather than inventing a figure.
 */

export type AccountStatus = 'PROSPECT' | 'CUSTOMER' | 'DORMANT' | 'FORMER_CUSTOMER';

export interface Account {
  id: string;
  name: string;
  status: AccountStatus;
  industry: string | null;
  website: string | null;
  domain: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  source: string | null;
  notes: string | null;
  owner: { id: string; fullName: string } | null;
  firstContactAt: string | null;
  firstWonAt: string | null;
  lastWonAt: string | null;
  lastActivityAt: string | null;
  active: boolean;
  leadCount: number;
  contactCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccountPage {
  items: Account[];
  total: number;
  limit: number;
  offset: number;
}

export function useAccounts(filters: {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): UseQueryResult<AccountPage> {
  const params: Record<string, unknown> = {};
  if (filters.search) params['search'] = filters.search;
  if (filters.status) params['status'] = filters.status;
  if (filters.limit) params['limit'] = filters.limit;
  if (filters.offset) params['offset'] = filters.offset;

  return useQuery({
    queryKey: ['accounts', params],
    queryFn: () => apiGet<AccountPage>('/accounts', params),
  });
}

/** The customer list for a picker on the lead form. */
export function useAccountOptions(search: string): UseQueryResult<AccountPage> {
  return useQuery({
    queryKey: ['accounts', { picker: true, search }],
    queryFn: () =>
      apiGet<AccountPage>('/accounts', search ? { search, limit: 50 } : { limit: 50 }),
    staleTime: 60 * 1000,
  });
}

// --- Customer 360 ------------------------------------------------------------

export interface Opportunity {
  id: string;
  leadNumber: string;
  name: string | null;
  status: string;
  priority: string;
  source: string | null;
  estimatedValue: number | null;
  wonValue: number | null;
  wonAt: string | null;
  lostAt: string | null;
  lostReason: string | null;
  nextFollowUpAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  product: { id: string; name: string; sku: string } | null;
  /** What the customer actually asked for. Never replaced by the product. */
  productInterest: string | null;
  assignedTo: { id: string; fullName: string } | null;
  contact: { id: string; name: string } | null;
}

export interface Customer360 {
  account: Omit<Account, 'leadCount' | 'contactCount' | 'createdAt' | 'updatedAt'>;
  contacts: {
    items: {
      id: string;
      name: string;
      mobile: string | null;
      email: string | null;
      notes: string | null;
      leadCount: number;
      createdAt: string;
    }[];
    total: number;
  };
  openOpportunities: { items: Opportunity[]; total: number };
  closedOpportunities: { items: Opportunity[]; total: number };
  commercial: {
    /**
     * Always 'crm-opportunities'.
     *
     * LeadFlow has no order table, so these are CRM figures and the screen says
     * so rather than implying invoiced revenue.
     */
    basis: 'crm-opportunities';
    wonCount: number;
    wonValue: number;
    averageDealValue: number | null;
    lostCount: number;
    lostEstimatedValue: number;
    openCount: number;
    openPipeline: number;
    firstWonAt: string | null;
    lastWonAt: string | null;
    repeatOrderCount: number;
    isRepeatCustomer: boolean;
  };
  products: {
    items: {
      productId: string;
      name: string;
      sku: string;
      category: string | null;
      active: boolean;
      enquiries: number;
      won: number;
      wonValue: number;
      lost: number;
      open: number;
    }[];
    /** How much of this customer's story the breakdown above does NOT cover. */
    leadsWithoutProduct: number;
  };
  conversations: {
    items: {
      id: string;
      channel: string;
      status: string;
      linkState: string;
      lastMessageAt: string | null;
      messageCount: number;
      contactName: string | null;
      leadId: string | null;
      leadNumber: string | null;
      owner: { id: string; fullName: string } | null;
    }[];
    total: number;
  };
  activities: {
    items: {
      id: string;
      type: string;
      description: string | null;
      leadId: string;
      leadNumber: string;
      performedBy: { id: string; fullName: string } | null;
      createdAt: string;
    }[];
    total: number;
  };
  followUps: {
    id: string;
    scheduledAt: string;
    type: string;
    status: string;
    title: string | null;
    notes: string | null;
    outcome: string | null;
    completedAt: string | null;
    assignedTo: { id: string; fullName: string };
    isOverdue: boolean;
  }[];
  crossSell: { productId: string; name: string; sku: string; category: string | null }[];
}

export function useCustomer360(id: string): UseQueryResult<Customer360> {
  return useQuery({
    queryKey: ['accounts', id, '360'],
    queryFn: () => apiGet<Customer360>(`/accounts/${id}/360`),
    enabled: Boolean(id),
  });
}

// --- writes ------------------------------------------------------------------

function useAccountMutation<TArgs>(
  request: (args: TArgs) => Promise<unknown>,
): UseMutationResult<unknown, Error, TArgs> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      // A customer change moves the customer KPIs, and re-parenting a lead
      // moves the lead list too.
      void queryClient.invalidateQueries({ queryKey: ['account-kpi'] });
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}

export function useCreateAccount() {
  return useAccountMutation((input: Record<string, unknown>) =>
    apiPost<{ account: Account }>('/accounts', input),
  );
}

export function useUpdateAccount() {
  return useAccountMutation(({ id, ...input }: { id: string } & Record<string, unknown>) =>
    apiPatch<Account>(`/accounts/${id}`, input),
  );
}

export function useChangeAccountStatus() {
  return useAccountMutation(
    ({ id, status, reason }: { id: string; status: AccountStatus; reason?: string }) =>
      apiPatch<Account>(`/accounts/${id}/status`, { status, reason }),
  );
}

export function useMergeAccounts() {
  return useAccountMutation(({ loserId, survivorId }: { loserId: string; survivorId: string }) =>
    apiPost(`/accounts/${loserId}/merge`, { survivorId }),
  );
}

// --- KPIs --------------------------------------------------------------------

export interface CustomerOverview {
  counts: {
    prospects: number;
    customers: number;
    dormant: number;
    formerCustomers: number;
    total: number;
  };
  newCustomers: number | null;
  conversionRate: number | null;
  repeat: {
    customersWithAnyWin: number;
    customersWithMultipleWins: number;
    /** Null below the sample floor — the counts above say as much, honestly. */
    repeatRate: number | null;
    averageWinsPerCustomer: number | null;
  };
  value: {
    totalWonValue: number;
    averageCustomerValue: number | null;
    repeatWonValue: number;
    repeatRevenueShare: number | null;
  };
}

export function useCustomerOverview(range?: string): UseQueryResult<CustomerOverview> {
  return useQuery({
    queryKey: ['account-kpi', 'overview', range ?? 'all'],
    queryFn: () => apiGet<CustomerOverview>('/accounts/kpi/overview', range ? { preset: range } : {}),
  });
}

export interface TopCustomers {
  items: {
    accountId: string;
    name: string;
    status: string;
    wonDeals: number;
    wonValue: number;
    averageDealValue: number | null;
    firstWonAt: string | null;
    lastWonAt: string | null;
    isRepeatCustomer: boolean;
  }[];
}

export function useTopCustomers(range?: string): UseQueryResult<TopCustomers> {
  return useQuery({
    queryKey: ['account-kpi', 'top-customers', range ?? 'all'],
    queryFn: () => apiGet<TopCustomers>('/accounts/kpi/top-customers', range ? { preset: range } : {}),
  });
}

export interface DemandByCustomerType {
  items: {
    productId: string;
    name: string;
    sku: string | null;
    category: string | null;
    active: boolean;
    prospect: number;
    existingCustomer: number;
    /** Leads with no customer attached. Never folded into either side. */
    unknown: number;
    total: number;
    existingCustomerShare: number | null;
  }[];
  totals: {
    prospect: number;
    existingCustomer: number;
    unknown: number;
    total: number;
    existingCustomerShare: number | null;
  };
  coverage: { leadsWithoutProduct: number; leadsWithoutAccount: number };
}

export function useDemandByCustomerType(range?: string): UseQueryResult<DemandByCustomerType> {
  return useQuery({
    queryKey: ['account-kpi', 'product-demand', range ?? 'all'],
    queryFn: () =>
      apiGet<DemandByCustomerType>('/accounts/kpi/product-demand', range ? { preset: range } : {}),
  });
}

export interface AcquisitionTrend {
  points: { date: string; count: number }[];
  total: number;
}

export function useAcquisitionTrend(range: string): UseQueryResult<AcquisitionTrend> {
  return useQuery({
    queryKey: ['account-kpi', 'acquisition', range],
    queryFn: () => apiGet<AcquisitionTrend>('/accounts/kpi/acquisition', { preset: range }),
  });
}

// --- backfill ----------------------------------------------------------------

export interface AccountMappingProgress {
  mapped: number;
  unmapped: number;
  total: number;
  percentMapped: number | null;
  /** Unmapped leads with no company name to group on. Shown, never hidden. */
  withoutCompanyName: number;
}

export function useAccountMappingProgress(): UseQueryResult<AccountMappingProgress> {
  return useQuery({
    queryKey: ['accounts', 'mapping', 'progress'],
    queryFn: () => apiGet<AccountMappingProgress>('/accounts/mapping/progress'),
  });
}

export interface MappingSuggestions {
  groups: {
    normalizedName: string;
    /** Every original spelling. The evidence a reviewer judges by. */
    variants: string[];
    leadCount: number;
    leads: { id: string; leadNumber: string; companyName: string | null; status: string }[];
    existingAccounts: { id: string; name: string; status: string }[];
  }[];
  withoutCompanyName: number;
  scanned: number;
}

export function useMappingSuggestions(): UseQueryResult<MappingSuggestions> {
  return useQuery({
    queryKey: ['accounts', 'mapping', 'suggestions'],
    queryFn: () => apiGet<MappingSuggestions>('/accounts/mapping/suggestions'),
  });
}

export function useAssignToAccount(): UseMutationResult<
  { leadsUpdated: number; contactsUpdated: number; requested: number },
  Error,
  { accountId: string; leadIds?: string[]; contactIds?: string[] }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input) =>
      apiPost<{ leadsUpdated: number; contactsUpdated: number; requested: number }>(
        '/accounts/mapping/assign',
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['account-kpi'] });
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}

// --- presentation ------------------------------------------------------------

/**
 * A KPI, or an em dash.
 *
 * Every figure here can legitimately be null, and printing "0" or "0%" in
 * those cases states something false about the business.
 */
export function formatCustomerKpi(
  value: number | null | undefined,
  kind: 'number' | 'percent' | 'currency' = 'number',
): string {
  if (value === null || value === undefined) return '—';

  if (kind === 'percent') return `${Math.round(value * 1000) / 10}%`;
  if (kind === 'currency') return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  return new Intl.NumberFormat().format(value);
}

export const ACCOUNT_STATUS_PRESENTATION: Record<
  AccountStatus,
  { label: string; className: string }
> = {
  PROSPECT: { label: 'Prospect', className: 'bg-slate-100 text-slate-700' },
  CUSTOMER: { label: 'Customer', className: 'bg-emerald-100 text-emerald-800' },
  DORMANT: { label: 'Dormant', className: 'bg-amber-100 text-amber-800' },
  FORMER_CUSTOMER: { label: 'Former customer', className: 'bg-red-100 text-red-800' },
};
