import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';
import { ToastProvider } from '../components/toast';
import { NewLeadDialog } from '../features/leads/new-lead-dialog';

/** Every field in the New lead form is reachable by its label (tap-to-focus on phones, screen readers). */
afterEach(() => vi.restoreAllMocks());

it('labels the New lead fields', async () => {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({ can: () => true, user: { id: 'u1', fullName: 'Asha' } } as never);
  vi.spyOn(apiClient, 'apiGet').mockResolvedValue({ items: [], hasMore: false, total: 0 } as never);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <MemoryRouter>
          <NewLeadDialog open onClose={() => undefined} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  for (const label of [/^First name/, /^Last name/, /^Mobile/, /^Email/, /^Company/, /^City/]) {
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  }
});
