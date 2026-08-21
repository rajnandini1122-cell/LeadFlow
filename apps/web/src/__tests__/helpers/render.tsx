import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Renders one screen with the providers it needs and a router positioned at a
 * given URL.
 *
 * Retries are disabled: a component test asserting an error state should see it
 * immediately rather than after three backoff attempts, which would either time
 * out or make the suite slow for no benefit.
 */
export function renderRoute(
  element: ReactNode,
  options: { path?: string; url?: string } = {},
): RenderResult {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  const path = options.path ?? '/';
  const url = options.url ?? path;

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path={path} element={element} />
          {/* Destinations the screens navigate to. Rendering a marker rather
              than the real page keeps each test to one unit. */}
          <Route path="/login" element={<p>Sign in page</p>} />
          <Route path="/forgot-password" element={<p>Forgot password page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
