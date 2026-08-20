import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './features/auth/auth-context';
import { LoginPage } from './features/auth/login-page';
import { DashboardPage } from './features/dashboard/dashboard-page';
import { AppShell } from './components/app-shell';
import { PlaceholderPage } from './components/placeholder-page';
import { ApiError } from './lib/api-client';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Retrying a 401/403/404 cannot help and just delays the error the
        // user needs to see.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

/** Gate for authenticated routes. Real enforcement is server-side. */
function RequireAuth(): React.JSX.Element {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  if (status === 'anonymous') return <Navigate to="/login" replace />;

  return <Outlet />;
}

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route element={<RequireAuth />}>
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route
                  path="leads"
                  element={
                    <PlaceholderPage
                      title="Leads"
                      phase="Phase 2"
                      description="Lead list, search, filters, assignment and duplicate detection."
                    />
                  }
                />
                <Route
                  path="follow-ups"
                  element={
                    <PlaceholderPage
                      title="Follow-ups"
                      phase="Phase 6"
                      description="Today, upcoming and overdue follow-ups, backed by the follow-up engine."
                    />
                  }
                />
                <Route
                  path="team"
                  element={
                    <PlaceholderPage
                      title="Team"
                      phase="Phase 4"
                      description="Invite users, assign roles and monitor team activity."
                    />
                  }
                />
                <Route
                  path="reports"
                  element={
                    <PlaceholderPage
                      title="Reports"
                      phase="Phase 4"
                      description="Team performance, lead conversion and activity reporting."
                    />
                  }
                />
                <Route
                  path="settings"
                  element={
                    <PlaceholderPage
                      title="Settings"
                      phase="Phase 4"
                      description="Organization profile, working hours and follow-up escalation rules."
                    />
                  }
                />
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
