import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './features/auth/auth-context';
import { LoginPage } from './features/auth/login-page';
import { RegisterPage } from './features/auth/register-page';
import { AcceptInvitationPage } from './features/auth/accept-invitation-page';
import { ForgotPasswordPage } from './features/auth/forgot-password-page';
import { ResetPasswordPage } from './features/auth/reset-password-page';
import { SecurityPage } from './features/settings/security-page';
import { DashboardPage } from './features/dashboard/dashboard-page';
import { LeadsPage } from './features/leads/leads-page';
import { LeadDetailPage } from './features/leads/lead-detail-page';
import { ImportLeadsPage } from './features/leads/import-leads-page';
import { ContactsPage } from './features/contacts/contacts-page';
import { ContactDetailPage } from './features/contacts/contact-detail-page';
import { FollowUpsPage } from './features/followups/follow-ups-page';
import { TeamPage } from './features/team/team-page';
import { ReportsPage } from './features/reports/reports-page';
import { DailyReportPage } from './features/reports/daily-report-page';
import { SettingsPage } from './features/settings/settings-page';
import { AppShell } from './components/app-shell';
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
            {/* Public: no session required. */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/invite/:token" element={<AcceptInvitationPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password/:token" element={<ResetPasswordPage />} />

            <Route element={<RequireAuth />}>
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="leads" element={<LeadsPage />} />
                {/* Before :id, or the router matches "import" as a lead id. */}
                <Route path="leads/import" element={<ImportLeadsPage />} />
                <Route path="leads/:id" element={<LeadDetailPage />} />
                <Route path="contacts" element={<ContactsPage />} />
                <Route path="contacts/:id" element={<ContactDetailPage />} />
                <Route path="follow-ups" element={<FollowUpsPage />} />
                <Route path="team" element={<TeamPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="reports/daily" element={<DailyReportPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="settings/security" element={<SecurityPage />} />
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
