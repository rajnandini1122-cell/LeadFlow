import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Paginated } from '@leadflow/api-types';
import { apiGet } from '../../lib/api-client';
import { ErrorNotice, SkeletonRows, StatusBadge } from '../../components/ui';
import { formatDate } from '../../lib/format';
import type { LeadSummary } from '../leads/use-leads';
import { useConversation, useLinkConversation } from './use-conversations';

/**
 * Choosing which lead a conversation belongs to.
 *
 * Two sources, in order of usefulness: the leads the system itself considered
 * plausible when it declined to choose, and then an ordinary search across the
 * rest of the pipeline.
 *
 * Both go through endpoints that already apply lead visibility, so a rep who
 * cannot see a colleague's lead cannot find it here either — searching must not
 * become a way to enumerate a pipeline one query at a time.
 */
export function LinkLeadDialog({
  conversationId,
  contactName,
  onClose,
  onLinked,
}: {
  conversationId: string;
  contactName: string | null;
  onClose: () => void;
  onLinked: (leadNumber: string) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const conversation = useConversation(conversationId);
  const link = useLinkConversation();

  const results = useQuery({
    queryKey: ['leads', 'link-search', search],
    queryFn: () => apiGet<Paginated<LeadSummary>>('/leads', { search, limit: 10 }),
    enabled: search.trim().length >= 2,
  });

  const candidates = conversation.data?.candidateLeads ?? [];

  const choose = (leadId: string, leadNumber: string): void => {
    link.mutate({ conversationId, leadId }, { onSuccess: () => onLinked(leadNumber) });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Link to an existing lead"
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <header className="flex items-start gap-3 border-b border-slate-100 p-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900">Link to an existing lead</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {contactName ? `Conversation with ${contactName}` : 'Unknown sender'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {link.isError && (
            <div className="mb-4">
              <ErrorNotice message="Could not link this conversation. It may already belong to a lead." />
            </div>
          )}

          {candidates.length > 0 && (
            <section className="mb-6">
              <h3 className="mb-1 text-sm font-medium text-slate-900">Possible matches</h3>
              <p className="mb-3 text-xs text-slate-500">
                Several active leads matched this person, so nothing was linked automatically.
              </p>

              <ul className="space-y-2">
                {candidates.map((lead) => (
                  <li
                    key={lead.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-slate-500">{lead.leadNumber}</span>
                        <StatusBadge status={lead.status as never} />
                      </div>
                      <p className="mt-1 text-sm text-slate-900">
                        {lead.companyName ?? lead.productInterest ?? 'No company recorded'}
                      </p>
                      <p className="text-xs text-slate-500">
                        Owner: {lead.assignedTo?.fullName ?? 'Unassigned'} · Created{' '}
                        {formatDate(lead.createdAt)}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={link.isPending}
                      onClick={() => choose(lead.id, lead.leadNumber)}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
                    >
                      Link this lead
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <label htmlFor="lead-search" className="mb-1 block text-sm font-medium text-slate-900">
              Search all leads
            </label>
            <input
              id="lead-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, company or mobile"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />

            {search.trim().length < 2 ? (
              <p className="mt-3 text-xs text-slate-500">Type at least two characters.</p>
            ) : results.isPending ? (
              <div className="mt-3">
                <SkeletonRows rows={3} />
              </div>
            ) : results.isError ? (
              <div className="mt-3">
                <ErrorNotice message="Could not search leads." />
              </div>
            ) : results.data.items.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No leads match that search.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {results.data.items.map((lead) => (
                  <li
                    key={lead.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-slate-500">{lead.leadNumber}</span>
                        <StatusBadge status={lead.status} />
                      </div>
                      <p className="mt-1 truncate text-sm text-slate-900">
                        {lead.name}
                        {lead.companyName ? ` · ${lead.companyName}` : ''}
                      </p>
                      <p className="text-xs text-slate-500">
                        Owner: {lead.assignedTo?.fullName ?? 'Unassigned'}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={link.isPending}
                      onClick={() => choose(lead.id, lead.leadNumber)}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      Link
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="border-t border-slate-100 px-5 py-3">
          <p className="text-xs text-slate-500">
            Linking never changes who the lead is assigned to.
          </p>
        </footer>
      </div>
    </div>
  );
}
