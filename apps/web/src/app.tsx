import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './features/auth/auth-context';
import { LoginPage } from './features/auth/login-page';
import { RegisterPage } from './features/auth/register-page';
import { AcceptInvitationPage } from './features/auth/accept-invitation-page';
import { ForgotPasswordPage } from './features/auth/forgot-password-page';
import { ResetPasswordPage } from './features/auth/reset-password-page';
import { SecurityPage } from './features/settings/security-page';
import { MarketingLayout } from './features/marketing/marketing-layout';
import { HomePage } from './features/marketing/home-page';
import { FeaturesPage } from './features/marketing/features-page';
import { PricingPage } from './features/marketing/pricing-page';
import { AboutPage } from './features/marketing/about-page';
import { ContactPage } from './features/marketing/contact-page';
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
import { BillingPage } from './features/settings/billing-page';
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

/** Shown while the session is being restored, before either tree is chosen. */
function Restoring(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
      Loading…
    </div>
  );
}

/** Gate for authenticated routes. Real enforcement is server-side. */
function RequireAuth(): React.JSX.Element {
  const { status } = useAuth();

  if (status === 'loading') return <Restoring />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;

  return <Outlet />;
}

/**
 * The front door.
 *
 * A signed-in visitor arriving at `/` almost always wants their work, not the
 * sales pitch — so they go to the dashboard. Anyone else gets the marketing
 * page, which is what used to be missing entirely: an anonymous visitor was
 * bounced straight to a password box with no explanation of what they were
 * signing in to.
 */
function Home(): React.JSX.Element {
  const { status } = useAuth();

  if (status === 'loading') return <Restoring />;
  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  return <HomePage />;
}

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/*
              Public marketing site. No session required, and deliberately
              wrapped in its own layout — a visitor deciding whether to sign up
              and a user doing their job need different chrome.
            */}
            <Route element={<MarketingLayout />}>
              <Route path="/" element={<Home />} />
              <Route path="/features" element={<FeaturesPage />} />
              <Route path="/pricing" element={<PricingPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/contact" element={<ContactPage />} />
            </Route>

            {/* Public: no session required. */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/invite/:token" element={<AcceptInvitationPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password/:token" element={<ResetPasswordPage />} />

            <Route element={<RequireAuth />}>
              <Route element={<AppShell />}>
                <Route path="dashboard" element={<DashboardPage />} />
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
                <Route path="settings/billing" element={<BillingPage />} />
                <Route path="settings/security" element={<SecurityPage />} />
              </Route>
            </Route>

            {/* Home decides where an unknown path lands, per session state. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
