import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CampaignEditorPage } from '../features/email/campaign-editor-page';
import * as apiClient from '../lib/api-client';

/**
 * Opening an EXISTING draft: the page first renders a loading state, then the
 * editor. Every hook must run on both renders — a hook after the loading
 * return made React throw ("Rendered more hooks than during the previous
 * render") and the page went blank in production.
 */

vi.mock('../features/auth/auth-context', () => ({
  useAuth: () => ({ can: () => true }),
}));

afterEach(() => vi.restoreAllMocks());

const draft = {
  id: 'c1',
  name: 'CRAVION – New Leads B2B Product Introduction – Nov 2026',
  category: 'PRODUCT_CATALOGUE',
  purpose: 'PROMOTIONAL',
  status: 'DRAFT',
  subject: 'Introducing our B2B catalogue',
  html: '<p>Dear {{first_name}}, our catalogue is attached.</p>',
  text: 'Dear {{first_name}}, our catalogue is attached.',
  assetIds: ['a1'],
  filter: {
    cities: ['Pune', 'Haveli'],
    statuses: ['NEW', 'QUALIFIED'],
    contacted: ['NEVER'],
    priorities: ['HIGH'],
    includeContacts: true,
  },
  scheduledAt: null,
  confirmedAt: null,
  startedAt: null,
  pausedAt: null,
  pauseReason: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: '2026-11-13T01:13:50.000Z',
  updatedAt: '2026-11-13T01:13:50.000Z',
  counts: {},
  broadcast: null,
};

function respond(url: string): unknown {
  if (url === '/email/campaigns/c1') return draft;
  if (url === '/email/campaigns/audience/options')
    return { cities: [{ name: 'Pune', count: 12 }], contacted: { never: 77, contacted: 1 } };
  if (url === '/email/templates') return [];
  if (url === '/email/assets')
    return [{ id: 'a1', fileName: 'Catalog.png', mimeType: 'image/png', sizeBytes: 2485323 }];
  if (url === '/email/mailbox')
    return {
      configured: true,
      sendingProvider: 'RESEND',
      smtp: { okAt: null },
      imap: { okAt: '2026-11-12T12:35:54.000Z' },
      provider: { okAt: '2026-11-12T13:25:28.000Z' },
      platform: { sendingEnabled: false, dispatcherEnabled: false },
    };
  if (url === '/email/campaigns/c1/readiness')
    return { intent: 'TEST', channel: 'RESEND_EMAIL', ok: true, checks: [] };
  if (url === '/email/campaigns/c1/preview')
    return { subject: draft.subject, html: draft.html, text: draft.text, attachments: [] };
  return [];
}

describe('Campaign editor, existing draft', () => {
  it('renders the editor after loading (no hooks-order crash)', async () => {
    vi.spyOn(apiClient, 'apiGet').mockImplementation(
      (url: string) =>
        // Resolve on a later tick, so the first render is the loading state.
        new Promise((resolve) => setTimeout(() => resolve(respond(url) as never), 10)),
    );
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      selected: 0,
      eligible: 0,
      excluded: { INVALID: 0, SUPPRESSED: 0, NO_CONSENT: 0, DUPLICATE: 0, EXCLUDED: 0 },
      sample: [],
      recipients: [],
      recipientsTruncated: false,
      recipientsListed: true,
      recipientsTotal: 0,
      undisplayedEligible: 0,
    } as never);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/campaigns/c1/edit']}>
          <Routes>
            <Route path="/campaigns/:id/edit" element={<CampaignEditorPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByDisplayValue(draft.name)).toBeInTheDocument();
    expect(screen.getByText('Contact history')).toBeInTheDocument();
    expect(errors.mock.calls.some((c) => String(c[0]).includes('Rendered more hooks'))).toBe(false);
  });
});
