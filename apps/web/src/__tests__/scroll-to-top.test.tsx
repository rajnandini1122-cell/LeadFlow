import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScrollToTop } from '../components/scroll-to-top';

/**
 * Starting each page at the top.
 *
 * The interesting case is the one that must NOT scroll: changing a filter or a
 * page number rewrites the query string while somebody is reading, and yanking
 * them back to the top mid-thought is worse than the problem this solves.
 */

let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAt(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <ScrollToTop />
      <Routes>
        <Route
          path="/leads"
          element={
            <>
              <Link to="/contacts">To contacts</Link>
              <Link to="/leads?status=won">Filter</Link>
            </>
          }
        />
        <Route path="/contacts" element={<p>Contacts</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ScrollToTop', () => {
  it('scrolls to the top when the path changes', async () => {
    const user = userEvent.setup();
    renderAt('/leads');
    scrollTo.mockClear();

    await user.click(document.querySelector('a[href="/contacts"]') as HTMLElement);

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
  });

  it('does NOT scroll when only the query string changes', async () => {
    const user = userEvent.setup();
    renderAt('/leads');
    scrollTo.mockClear();

    // A filter applied halfway down a list. The person is reading; leave them
    // where they are.
    await user.click(document.querySelector('a[href="/leads?status=won"]') as HTMLElement);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('renders nothing of its own', () => {
    const { container } = render(
      <MemoryRouter>
        <ScrollToTop />
      </MemoryRouter>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
