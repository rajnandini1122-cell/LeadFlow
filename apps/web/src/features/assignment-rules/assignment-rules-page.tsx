import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AssignmentRuleView,
  CreateAssignmentRuleRequest,
  OrganizationDetail,
  TeamListItem,
} from '@leadflow/api-types';
import { apiGet } from '../../lib/api-client';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { useActiveProducts } from '../products/use-products';
import { RulePreview } from './rule-preview';
import { RuleFormDialog, type RuleFormValues } from './rule-form-dialog';
import { useAssignmentRules, useCreateRule, useUpdateRule } from './use-assignment-rules';

/**
 * The routing table.
 *
 * Which team handles which work — and nothing about who in that team ends up
 * with it, or when. This screen configures and explains the decision; making
 * it happen belongs to the phase that also writes the lead.
 */
export function AssignmentRulesPage(): React.JSX.Element {
  const { can } = useAuth();
  const canManage = can('assignment_rule.manage');

  const rules = useAssignmentRules();
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();

  const teams = useQuery({
    queryKey: ['teams', { includeArchived: false }],
    queryFn: () => apiGet<TeamListItem[]>('/teams'),
    enabled: canManage,
  });
  const products = useActiveProducts();
  const organization = useQuery({
    queryKey: ['organization'],
    queryFn: () => apiGet<OrganizationDetail>('/organizations/current'),
    enabled: canManage,
  });

  const [editing, setEditing] = useState<AssignmentRuleView | null>(null);
  const [creating, setCreating] = useState(false);

  if (rules.isPending) {
    return (
      <div>
        <PageHeader title="Assignment rules" subtitle="Which team handles which work." />
        <Card>
          <SkeletonRows />
        </Card>
      </div>
    );
  }

  if (rules.isError) {
    return (
      <div>
        <PageHeader title="Assignment rules" />
        <ErrorNotice message="The routing rules could not be loaded. Please try again." />
      </div>
    );
  }

  const rows = rules.data ?? [];
  const active = rows.filter((rule) => rule.status === 'ACTIVE');

  const submit = (values: RuleFormValues): void => {
    // Spread rather than `undefined` values: the shared contract has
    // `exactOptionalPropertyTypes` on, so an absent field and a field set to
    // undefined are different things — and the API refuses unknown keys.
    const body: CreateAssignmentRuleRequest = {
      name: values.name,
      targetTeamId: values.targetTeamId,
      isFallback: values.isFallback,
      ...(values.description ? { description: values.description } : {}),
      ...(!values.isFallback && values.source ? { source: values.source } : {}),
      ...(!values.isFallback && values.productId ? { productId: values.productId } : {}),
      ...(values.priority ? { priority: Number(values.priority) } : {}),
    };

    if (editing) {
      updateRule.mutate(
        {
          id: editing.id,
          name: body.name,
          description: values.description || null,
          source: values.isFallback ? null : values.source || null,
          productId: values.isFallback ? null : values.productId || null,
          targetTeamId: body.targetTeamId,
          ...(values.priority ? { priority: Number(values.priority) } : {}),
        },
        { onSuccess: () => setEditing(null) },
      );
      return;
    }

    createRule.mutate(body, { onSuccess: () => setCreating(false) });
  };

  return (
    <div>
      <PageHeader
        title="Assignment rules"
        subtitle="Which team handles which work. Rules run in priority order; the fallback is last."
        action={
          canManage ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              New rule
            </button>
          ) : undefined
        }
      />

      <Card className="mb-6">
        <CardHeader
          title={`${active.length} active ${active.length === 1 ? 'rule' : 'rules'}`}
          subtitle="Evaluated top to bottom. The first rule whose every criterion matches wins."
        />

        {rows.length === 0 ? (
          <EmptyState
            title="No routing rules yet"
            description={
              canManage
                ? 'Add a rule to send work from a source, or about a product, to one of your sales teams.'
                : 'An administrator has not configured any routing rules yet.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
                <th className="px-5 py-2 font-medium">Priority</th>
                <th className="px-5 py-2 font-medium">Rule</th>
                <th className="px-5 py-2 font-medium">Matches</th>
                <th className="px-5 py-2 font-medium">Team</th>
                <th className="px-5 py-2 font-medium">Status</th>
                {canManage && <th className="px-5 py-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((rule) => (
                <tr key={rule.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-5 py-3 text-slate-500 tabular-nums">
                    {rule.isFallback ? 'Last' : rule.priority}
                  </td>
                  <td className="px-5 py-3">
                    <span className="font-medium text-slate-900">{rule.name}</span>
                    {rule.description && (
                      <p className="mt-0.5 text-xs text-slate-500">{rule.description}</p>
                    )}
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-600">{criteriaSummary(rule)}</td>
                  <td className="px-5 py-3 text-slate-600">{rule.targetTeam.name}</td>
                  <td className="px-5 py-3">
                    <StatusPill status={rule.status} />
                  </td>
                  {canManage && (
                    <td className="px-5 py-3 text-right">
                      <div className="flex justify-end gap-3 text-xs">
                        {rule.status !== 'ARCHIVED' && (
                          <>
                            <button
                              type="button"
                              onClick={() => setEditing(rule)}
                              className="text-slate-500 hover:text-slate-900"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                updateRule.mutate({
                                  id: rule.id,
                                  status: rule.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
                                })
                              }
                              className="text-slate-500 hover:text-slate-900"
                            >
                              {rule.status === 'ACTIVE' ? 'Pause' : 'Activate'}
                            </button>
                            <button
                              type="button"
                              onClick={() => updateRule.mutate({ id: rule.id, status: 'ARCHIVED' })}
                              className="text-slate-500 hover:text-red-600"
                            >
                              Archive
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <RulePreview
        sources={organization.data?.settings.leadSources ?? []}
        products={products.data?.items ?? []}
      />

      <RuleFormDialog
        open={creating || editing !== null}
        rule={editing ?? undefined}
        teams={teams.data ?? []}
        products={products.data?.items ?? []}
        sources={organization.data?.settings.leadSources ?? []}
        saving={createRule.isPending || updateRule.isPending}
        error={createRule.error ?? updateRule.error}
        onClose={() => {
          setCreating(false);
          setEditing(null);
          createRule.reset();
          updateRule.reset();
        }}
        onSubmit={submit}
      />
    </div>
  );
}

/** What a rule matches, in words rather than a row of blanks. */
function criteriaSummary(rule: AssignmentRuleView): string {
  if (rule.isFallback) return 'Anything not matched above';

  const parts: string[] = [];
  if (rule.source) parts.push(`source ${rule.source}`);
  if (rule.product) parts.push(`product ${rule.product.name}`);

  // Every criterion must hold, so the summary says "and" rather than listing
  // them as though any one would do.
  return parts.join(' and ');
}

function StatusPill({ status }: { status: string }): React.JSX.Element {
  const styles =
    status === 'ACTIVE'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'PAUSED'
        ? 'bg-amber-50 text-amber-700'
        : 'bg-slate-100 text-slate-500';

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}
