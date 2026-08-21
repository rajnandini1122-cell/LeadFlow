import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AuthProvider } from '../features/auth/auth-context';
import { LoginPage } from '../features/auth/login-page';
import { RegisterPage } from '../features/auth/register-page';
import { ForgotPasswordPage } from '../features/auth/forgot-password-page';
import { Copyright, Logo, LogoMark } from '../components/brand';

/**
 * The brand appears on every unauthenticated screen.
 *
 * Regression cover for a real miss: the logo and copyright were added to the
 * shared AuthLayout, but the login page was the one screen still rolling its
 * own chrome — so it silently got neither. Asserting per screen, rather than
 * on the layout, is what catches a page that opts out of the shared one.
 */
function renderScreen(element: React.ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>{element}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Brand on the unauthenticated screens', () => {
  it.each([
    ['login', <LoginPage key="login" />],
    ['register', <RegisterPage key="register" />],
    ['forgot password', <ForgotPasswordPage key="forgot" />],
  ])('the %s screen shows the logo and links home', (_name, element) => {
    renderScreen(element);

    const home = screen.getByRole('link', { name: 'LeadFlow home' });
    expect(home).toHaveAttribute('href', '/');
    // The mark itself, not just the wordmark: an <svg> inside that link.
    expect(home.querySelector('svg')).not.toBeNull();
  });

  it.each([
    ['login', <LoginPage key="login" />],
    ['register', <RegisterPage key="register" />],
    ['forgot password', <ForgotPasswordPage key="forgot" />],
  ])('the %s screen shows the copyright', (_name, element) => {
    renderScreen(element);

    expect(screen.getByText(/Cravion Ventures/)).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });
});

describe('Brand components', () => {
  it('renders the mark as decoration by default', () => {
    const { container } = render(<LogoMark />);
    const svg = container.querySelector('svg');

    // Beside a wordmark it would otherwise be announced twice.
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg?.querySelectorAll('rect').length).toBeGreaterThan(0);
  });

  it('describes itself when it stands alone', () => {
    render(<LogoMark title="LeadFlow" />);
    expect(screen.getByRole('img', { name: 'LeadFlow' })).toBeInTheDocument();
  });

  it('renders the wordmark as selectable text, not paths', () => {
    const { container } = render(<Logo />);

    // Text in the DOM means it is readable, searchable and matches the site's
    // typography — none of which is true of a word drawn as SVG paths.
    expect(container.textContent).toBe('LeadFlow');
  });

  it('states the owner and the year from one place', () => {
    const { container } = render(<Copyright />);
    const text = within(container).getByText(/Cravion Ventures/);

    expect(text.textContent).toContain('2026');
    expect(text.textContent).toContain('™');
  });
});
