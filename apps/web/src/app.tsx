import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './features/auth/auth-context';
import { ScrollToTop } from './components/scroll-to-top';
import { LoginPage } from './features/auth/login-page';
import { RegisterPage } from './features/auth/register-page';
import { AcceptInvitationPage } from './features/auth/accept-invitation-page';
import { ForgotPasswordPage } from './features/auth/forgot-password-page';
import { ResetPasswordPage } from './features/auth/reset-password-page';
import { HomePage } from './features/marketing/home-page';
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
/*
 * ROUTE-LEVEL CODE SPLITTING.
 *
 * The production bundle was a single 769 kB chunk, which on Android meant the
 * WebView downloaded and parsed the entire application — every chart, every
 * report, the whole omnichannel inbox — before it could paint a login box.
 *
 * What stays eager is the first screen somebody can actually see: the landing
 * page and the auth shell. Everything behind a password is fetched when it is
 * first visited, by which point the app is interactive and the fetch is
 * invisible.
 *
 * Split per ROUTE rather than per component on purpose. Finer granularity
 * trades one large download for dozens of small round trips, which on a slow
 * mobile connection is the worse deal.
 */
const SecurityPage = lazy(() => import('./features/settings/security-page').then((m) => ({ default: m.SecurityPage })));
const MarketingLayout = lazy(() => import('./features/marketing/marketing-layout').then((m) => ({ default: m.MarketingLayout })));
const FeaturesPage = lazy(() => import('./features/marketing/features-page').then((m) => ({ default: m.FeaturesPage })));
const PricingPage = lazy(() => import('./features/marketing/pricing-page').then((m) => ({ default: m.PricingPage })));
const AboutPage = lazy(() => import('./features/marketing/about-page').then((m) => ({ default: m.AboutPage })));
const ContactPage = lazy(() => import('./features/marketing/contact-page').then((m) => ({ default: m.ContactPage })));
const DashboardPage = lazy(() => import('./features/dashboard/dashboard-page').then((m) => ({ default: m.DashboardPage })));
const LeadsPage = lazy(() => import('./features/leads/leads-page').then((m) => ({ default: m.LeadsPage })));
const ChannelReviewPage = lazy(() => import('./features/omnichannel/channel-review-page').then((m) => ({ default: m.ChannelReviewPage })));
const InboxPage = lazy(() => import('./features/omnichannel/inbox-page').then((m) => ({ default: m.InboxPage })));
const ChannelIntegrationsPage = lazy(() => import('./features/settings/channel-integrations-page').then((m) => ({ default: m.ChannelIntegrationsPage })));
const LeadDetailPage = lazy(() => import('./features/leads/lead-detail-page').then((m) => ({ default: m.LeadDetailPage })));
const ImportLeadsPage = lazy(() => import('./features/leads/import-leads-page').then((m) => ({ default: m.ImportLeadsPage })));
const ContactsPage = lazy(() => import('./features/contacts/contacts-page').then((m) => ({ default: m.ContactsPage })));
const ProductsPage = lazy(() => import('./features/products/products-page').then((m) => ({ default: m.ProductsPage })));
const ProductIntelligencePage = lazy(() => import('./features/products/product-intelligence-page').then((m) => ({ default: m.ProductIntelligencePage })));
const ProductMappingPage = lazy(() => import('./features/products/product-mapping-page').then((m) => ({ default: m.ProductMappingPage })));
const CustomersPage = lazy(() => import('./features/accounts/customers-page').then((m) => ({ default: m.CustomersPage })));
const Customer360Page = lazy(() => import('./features/accounts/customer-360-page').then((m) => ({ default: m.Customer360Page })));
const CustomerKpiPage = lazy(() => import('./features/accounts/customer-kpi-page').then((m) => ({ default: m.CustomerKpiPage })));
const CustomerMappingPage = lazy(() => import('./features/accounts/customer-mapping-page').then((m) => ({ default: m.CustomerMappingPage })));
const RetentionPage = lazy(() => import('./features/accounts/retention-page').then((m) => ({ default: m.RetentionPage })));
const ContactDetailPage = lazy(() => import('./features/contacts/contact-detail-page').then((m) => ({ default: m.ContactDetailPage })));
const FollowUpsPage = lazy(() => import('./features/followups/follow-ups-page').then((m) => ({ default: m.FollowUpsPage })));
const TeamPage = lazy(() => import('./features/team/team-page').then((m) => ({ default: m.TeamPage })));
const SalesTeamsPage = lazy(() => import('./features/sales-teams/sales-teams-page').then((m) => ({ default: m.SalesTeamsPage })));
const TeamDetailPage = lazy(() => import('./features/sales-teams/team-detail-page').then((m) => ({ default: m.TeamDetailPage })));
const TerritoriesPage = lazy(() => import('./features/territories/territories-page').then((m) => ({ default: m.TerritoriesPage })));
const IntakesPage = lazy(() => import('./features/intakes/intakes-page').then((m) => ({ default: m.IntakesPage })));
const AssignmentRulesPage = lazy(() => import('./features/assignment-rules/assignment-rules-page').then((m) => ({ default: m.AssignmentRulesPage })));
const ReportsPage = lazy(() => import('./features/reports/reports-page').then((m) => ({ default: m.ReportsPage })));
const DailyReportPage = lazy(() => import('./features/reports/daily-report-page').then((m) => ({ default: m.DailyReportPage })));
const SettingsPage = lazy(() => import('./features/settings/settings-page').then((m) => ({ default: m.SettingsPage })));
const BillingPage = lazy(() => import('./features/settings/billing-page').then((m) => ({ default: m.BillingPage })));

function Restoring(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
      Loading…
    </div>
  );
}

/** Gate for authenticated routes. Real enforcement is server-side. */
function RequireAuth(): React.JSX.Element {
  const { status, signedOut } = useAuth();

  if (status === 'loading') return <Restoring />;

  /*
   * Two different anonymous states, two different destinations.
   *
   * Someone whose session expired, or who deep-linked to a protected page,
   * wants the login form — they were trying to get IN. Someone who just
   * pressed Sign out was trying to get OUT, and showing them another password
   * box reads as "signing out failed".
   *
   * This also removes a race: `logout()` navigates home while clearing the
   * session, and the clear commits first. Whichever redirect wins now, both
   * agree on where a deliberate sign-out lands.
   */
  if (status === 'anonymous') {
    return <Navigate to={signedOut ? '/' : '/login'} replace />;
  }

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
          {/* Every route change starts at the top, as a real page load would. */}
          <ScrollToTop />
          {/*
            One boundary around the whole route tree.
            `Restoring` is the same fallback session restoration already uses,
            so a lazy chunk arriving and a session being checked look identical
            rather than flashing two different loading states at somebody.
          */}
          <Suspense fallback={<Restoring />}>
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
                <Route path="inbox" element={<InboxPage />} />
                <Route path="leads" element={<LeadsPage />} />
                {/* Before :id, or the router matches "import" as a lead id. */}
                <Route path="leads/review" element={<ChannelReviewPage />} />
                <Route path="leads/import" element={<ImportLeadsPage />} />
                <Route path="leads/:id" element={<LeadDetailPage />} />
                <Route path="products" element={<ProductsPage />} />
                {/* Before ':id'-style routes would matter; both are literal. */}
                <Route path="products/mapping" element={<ProductMappingPage />} />
                <Route path="products/intelligence" element={<ProductIntelligencePage />} />
                {/*
                  Customers sit above Contacts: a customer is the company, a
                  contact is a person at it, and the order on screen should say
                  so.
                */}
                <Route path="customers" element={<CustomersPage />} />
                <Route path="customers/mapping" element={<CustomerMappingPage />} />
                <Route path="customers/kpi" element={<CustomerKpiPage />} />
                <Route path="customers/retention" element={<RetentionPage />} />
                <Route path="customers/:id" element={<Customer360Page />} />
                <Route path="contacts" element={<ContactsPage />} />
                <Route path="contacts/:id" element={<ContactDetailPage />} />
                <Route path="follow-ups" element={<FollowUpsPage />} />
                <Route path="team" element={<TeamPage />} />
                <Route path="sales-teams" element={<SalesTeamsPage />} />
                <Route path="sales-teams/:id" element={<TeamDetailPage />} />
                <Route path="territories" element={<TerritoriesPage />} />
                <Route path="website-enquiries" element={<IntakesPage />} />
                <Route path="assignment-rules" element={<AssignmentRulesPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="reports/daily" element={<DailyReportPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="settings/channels" element={<ChannelIntegrationsPage />} />
                <Route path="settings/billing" element={<BillingPage />} />
                <Route path="settings/security" element={<SecurityPage />} />
              </Route>
            </Route>

            {/* Home decides where an unknown path lands, per session state. */}
            <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
