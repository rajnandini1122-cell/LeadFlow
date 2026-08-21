import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Avatar,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { MergeContactsDialog } from './merge-contacts-dialog';
import { useContacts, useDuplicateGroups, type Contact } from './use-contacts';

type Tab = 'all' | 'duplicates';

/**
 * Contacts — the people, separate from the deals.
 *
 * A lead is one buying conversation; a contact is the person having it. Keeping
 * them apart is what lets a customer's history survive a closed deal: the same
 * person enquiring again is a second lead on the same contact, not a stranger.
 */
export function ContactsPage(): React.JSX.Element {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const contacts = useContacts(search);
  const canReview = can('contact.update');
  const duplicates = useDuplicateGroups(canReview && tab === 'duplicates');

  const rows = useMemo(
    () => (contacts.data?.pages ?? []).flatMap((page) => page.items),
    [contacts.data],
  );
  const total = contacts.data?.pages[0]?.total ?? null;

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle={
          contacts.isPending
            ? 'Loading contacts…'
            : total === null
              ? `${rows.length} contacts`
              : rows.length >= total
                ? `${total} ${total === 1 ? 'contact' : 'contacts'}`
                : `Showing ${rows.length} of ${total}`
        }
      />

      {canReview && (
        <div className="mb-4 flex gap-1.5" role="tablist" aria-label="Contact views">
          <TabButton label="All contacts" active={tab === 'all'} onClick={() => setTab('all')} />
          <TabButton
            label="Review duplicates"
            active={tab === 'duplicates'}
            onClick={() => setTab('duplicates')}
            count={tab === 'duplicates' ? duplicates.data?.length : undefined}
          />
        </div>
      )}

      {tab === 'all' ? (
        <>
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search name, company, mobile or email…"
            className="mb-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />

          <Card>
            {contacts.isPending ? (
              <SkeletonRows rows={8} />
            ) : contacts.isError ? (
              <ErrorNotice message="Could not load contacts." />
            ) : rows.length === 0 ? (
              <EmptyState
                icon="⌕"
                title="No contacts match"
                description={
                  search
                    ? 'Try a different search term.'
                    : 'Contacts are created automatically when you add or import a lead.'
                }
              />
            ) : (
              <>
                <ul className="divide-y divide-slate-100">
                  {rows.map((contact) => (
                    <ContactRow key={contact.id} contact={contact} />
                  ))}
                </ul>

                {contacts.hasNextPage && (
                  <div className="border-t border-slate-100 p-4 text-center">
                    <button
                      type="button"
                      onClick={() => void contacts.fetchNextPage()}
                      disabled={contacts.isFetchingNextPage}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      {contacts.isFetchingNextPage ? 'Loading…' : 'Load 25 more'}
                    </button>
                  </div>
                )}
              </>
            )}
          </Card>
        </>
      ) : (
        <DuplicateReview />
      )}
    </>
  );
}

/**
 * Duplicate review.
 *
 * Candidates are matched on exact mobile or email only, and shown for a human
 * to decide on. Nothing merges on its own: two colleagues who both used the
 * company's `info@` address are a real pair of customers, not one record.
 */
function DuplicateReview(): React.JSX.Element {
  const groups = useDuplicateGroups(true);
  const [pair, setPair] = useState<{ source: Contact; target: Contact } | null>(null);

  if (groups.isPending) {
    return (
      <Card>
        <SkeletonRows rows={4} />
      </Card>
    );
  }

  if (groups.isError) {
    return (
      <Card>
        <ErrorNotice message="Could not load duplicates." />
      </Card>
    );
  }

  if (groups.data.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="✓"
          title="No duplicates found"
          description="No two contacts share a mobile number or email address."
        />
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {groups.data.map((group) => (
          <Card key={`${group.matchedOn}-${group.value}`}>
            <CardHeader
              title={group.value}
              subtitle={`${group.contacts.length} contacts share this ${group.matchedOn}`}
            />
            <ul className="divide-y divide-slate-100">
              {group.contacts.map((contact, index) => (
                <li key={contact.id} className="flex items-center gap-3 px-5 py-3">
                  <Avatar name={contact.name} />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/contacts/${contact.id}`}
                      className="truncate text-sm font-medium text-slate-900 hover:underline"
                    >
                      {contact.name}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {contact.companyName ?? 'No company'} · {contact.leadCount}{' '}
                      {contact.leadCount === 1 ? 'lead' : 'leads'}
                    </p>
                  </div>
                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setPair({ source: contact, target: group.contacts[0] as Contact })
                      }
                      className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                    >
                      Review merge
                    </button>
                  )}
                  {index === 0 && (
                    <span className="rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-500">
                      Oldest
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>

      <MergeContactsDialog
        open={pair !== null}
        source={pair?.source ?? null}
        target={pair?.target ?? null}
        onClose={() => setPair(null)}
      />
    </>
  );
}

function TabButton({
  label,
  active,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number | undefined;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-lg px-3.5 py-2 text-sm font-medium transition ${
        active
          ? 'bg-slate-900 text-white'
          : 'bg-white text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50'
      }`}
    >
      {label}
      {count !== undefined && (
        <span className="ml-2 rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}

function ContactRow({ contact }: { contact: Contact }): React.JSX.Element {
  return (
    <li>
      <Link
        to={`/contacts/${contact.id}`}
        className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-slate-50"
      >
        <Avatar name={contact.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">{contact.name}</p>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {contact.companyName ? `${contact.companyName} · ` : ''}
            {contact.mobile ?? contact.email ?? 'No contact details'}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 tabular-nums">
          {contact.leadCount} {contact.leadCount === 1 ? 'lead' : 'leads'}
        </span>
      </Link>
    </li>
  );
}
