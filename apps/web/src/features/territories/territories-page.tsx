import { useState } from 'react';
import type { TerritoryListItem } from '@leadflow/api-types';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
} from '../../components/ui';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { CoverageEditor } from './coverage-editor';
import { TerritoryResolver } from './territory-resolver';
import { TerritoryFormDialog, type TerritoryFormValues } from './territory-form-dialog';
import { useCreateTerritory, useTerritories, useUpdateTerritory } from './use-territories';

/**
 * The map.
 *
 * Which places belong to which named scope — and nothing about who handles
 * them. A territory names no team here for the same reason it has no team
 * column in the database: assignment rules are the one place routing is
 * decided, and a second answer on this screen would be a second answer in
 * production.
 */
export function TerritoriesPage(): React.JSX.Element {
  const { can } = useAuth();
  const canManage = can('territory.manage');

  const territories = useTerritories();
  const createTerritory = useCreateTerritory();
  const updateTerritory = useUpdateTerritory();

  const [editing, setEditing] = useState<TerritoryListItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  if (territories.isPending) {
    return (
      <div>
        <PageHeader title="Territories" subtitle="Which places belong to which sales scope." />
        <Card>
          <SkeletonRows />
        </Card>
      </div>
    );
  }

  if (territories.isError) {
    return (
      <div>
        <PageHeader title="Territories" />
        <ErrorNotice message="The territories could not be loaded. Please try again." />
      </div>
    );
  }

  const rows = territories.data ?? [];
  const active = rows.filter((territory) => territory.status === 'ACTIVE');

  const submit = (values: TerritoryFormValues): void => {
    if (editing) {
      updateTerritory.mutate(
        { id: editing.id, name: values.name, description: values.description || null },
        { onSuccess: () => setEditing(null) },
      );
      return;
    }

    createTerritory.mutate(
      { name: values.name, ...(values.description ? { description: values.description } : {}) },
      { onSuccess: () => setCreating(false) },
    );
  };

  const archive = (territory: TerritoryListItem): void => {
    setArchiveError(null);
    updateTerritory.mutate(
      { id: territory.id, status: 'ARCHIVED' },
      {
        onError: (error) => {
          /*
           * Surfaced here rather than swallowed, because the refusal is the
           * useful part: the API names the active rules still routing to this
           * territory, and the administrator needs those names to know what to
           * pause before trying again.
           */
          setArchiveError(
            error instanceof ApiError
              ? [error.message, ...(error.details?.['status'] ?? [])].join(' ')
              : 'This territory could not be archived.',
          );
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        title="Territories"
        subtitle="Geography, resolved to a name. Assignment rules decide which team handles each one."
        action={
          canManage ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              New territory
            </button>
          ) : undefined
        }
      />

      {archiveError && (
        <div className="mb-4">
          <ErrorNotice message={archiveError} />
        </div>
      )}

      <Card className="mb-6">
        <CardHeader
          title={`${active.length} active ${active.length === 1 ? 'territory' : 'territories'}`}
          subtitle="The most specific configured place wins: postal code, then city, then state, then country."
        />

        {rows.length === 0 ? (
          <EmptyState
            title="No territories yet"
            description={
              canManage
                ? 'Add a territory, then give it the countries, states, cities or postal codes it covers.'
                : 'An administrator has not configured any territories yet.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
                <th className="px-5 py-2 font-medium">Territory</th>
                <th className="px-5 py-2 font-medium">Covers</th>
                <th className="px-5 py-2 font-medium tabular-nums">Places</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((territory) => (
                <TerritoryRow
                  key={territory.id}
                  territory={territory}
                  canManage={canManage}
                  expanded={expanded === territory.id}
                  onToggle={() =>
                    setExpanded((current) => (current === territory.id ? null : territory.id))
                  }
                  onEdit={() => setEditing(territory)}
                  onArchive={() => archive(territory)}
                  onReactivate={() =>
                    updateTerritory.mutate({ id: territory.id, status: 'ACTIVE' })
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <TerritoryResolver />

      <TerritoryFormDialog
        open={creating || editing !== null}
        territory={editing ?? undefined}
        saving={createTerritory.isPending || updateTerritory.isPending}
        error={createTerritory.error ?? updateTerritory.error}
        onClose={() => {
          setCreating(false);
          setEditing(null);
          createTerritory.reset();
          updateTerritory.reset();
        }}
        onSubmit={submit}
      />
    </div>
  );
}

function TerritoryRow({
  territory,
  canManage,
  expanded,
  onToggle,
  onEdit,
  onArchive,
  onReactivate,
}: {
  territory: TerritoryListItem;
  canManage: boolean;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onReactivate: () => void;
}): React.JSX.Element {
  return (
    <>
      <tr className="border-b border-slate-50 last:border-0">
        <td className="px-5 py-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="text-left font-medium text-slate-900 hover:underline"
          >
            {territory.name}
          </button>
          {territory.description && (
            <p className="mt-0.5 text-xs text-slate-500">{territory.description}</p>
          )}
        </td>
        <td className="px-5 py-3 text-xs text-slate-600">
          {territory.coverageSummary || <span className="text-slate-400">Nothing yet</span>}
        </td>
        <td className="px-5 py-3 tabular-nums text-slate-600">{territory.coverageCount}</td>
        <td className="px-5 py-3">
          <StatusPill status={territory.status} />
        </td>
        <td className="px-5 py-3 text-right">
          {canManage && (
            <div className="flex justify-end gap-3 text-xs">
              {territory.status === 'ACTIVE' ? (
                <>
                  <button
                    type="button"
                    onClick={onEdit}
                    className="text-slate-500 hover:text-slate-900"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={onArchive}
                    className="text-slate-500 hover:text-red-600"
                  >
                    Archive
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={onReactivate}
                  className="text-slate-500 hover:text-slate-900"
                >
                  Reactivate
                </button>
              )}
            </div>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-slate-50 bg-slate-50/50">
          <td colSpan={5} className="p-0">
            <CoverageEditor territoryId={territory.id} canManage={canManage} />
          </td>
        </tr>
      )}
    </>
  );
}

function StatusPill({ status }: { status: string }): React.JSX.Element {
  const styles =
    status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500';

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}
