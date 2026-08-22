import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { NotificationsMenu, type AttentionItem } from '../components/notifications-menu';

/**
 * The attention bell.
 *
 * It aggregates live counts; it is not a notification feed. The assertions that
 * matter are the ones keeping it honest: nothing is shown that is not actually
 * outstanding, a zero count is never dressed up as an item, and the badge never
 * disagrees with the list behind it.
 */

const items: AttentionItem[] = [
  { id: 'overdue', count: 2, label: 'Overdue follow-ups', to: '/follow-ups', tone: 'urgent' },
  { id: 'review', count: 1, label: 'Conversations needing review', to: '/leads/review', tone: 'normal' },
  { id: 'unassigned', count: 0, label: 'Unassigned conversations', to: '/inbox', tone: 'normal' },
];

function renderMenu(list: AttentionItem[] = items) {
  return render(
    <MemoryRouter>
      <NotificationsMenu items={list} />
    </MemoryRouter>,
  );
}

describe('NotificationsMenu', () => {
  beforeEach(() => {
    // The badge remembers what has been seen. Without clearing it, one test
    // opening the menu would silence the badge for every test after it.
    globalThis.localStorage.clear();
  });

  it('totals only what is actually outstanding', async () => {
    renderMenu();

    // 2 + 1, and NOT the zero-count row.
    expect(
      await screen.findByRole('button', { name: /3 items need attention/i }),
    ).toBeInTheDocument();
  });

  it('lists each outstanding item with somewhere to go', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /need attention/i }));

    expect(screen.getByRole('menuitem', { name: /overdue follow-ups/i })).toHaveAttribute(
      'href',
      '/follow-ups',
    );
    expect(
      screen.getByRole('menuitem', { name: /conversations needing review/i }),
    ).toHaveAttribute('href', '/leads/review');
  });

  it('never lists something with a count of zero', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /need attention/i }));

    // A "0 unassigned" row trains people to ignore the bell.
    expect(screen.queryByText(/unassigned conversations/i)).not.toBeInTheDocument();
  });

  it('says so plainly when nothing needs attention', async () => {
    const user = userEvent.setup();
    renderMenu(items.map((item) => ({ ...item, count: 0 })));

    const bell = screen.getByRole('button', { name: /nothing needs attention/i });
    await user.click(bell);

    expect(screen.getByText(/nothing needs attention right now/i)).toBeInTheDocument();
  });

  it('is closed until asked', () => {
    renderMenu();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /need attention/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  describe('the badge, once you have looked', () => {
    it('clears after the menu is opened', async () => {
      const user = userEvent.setup();
      renderMenu();

      await user.click(screen.getByRole('button', { name: /3 items need attention/i }));

      // Nagging about work somebody has already seen is how a badge gets
      // ignored within a day.
      expect(
        await screen.findByRole('button', { name: /nothing needs attention/i }),
      ).toBeInTheDocument();
    });

    it('still LISTS everything outstanding after clearing', async () => {
      const user = userEvent.setup();
      renderMenu();

      await user.click(screen.getByRole('button', { name: /need attention/i }));

      // The badge and the list answer different questions. Hiding real work
      // because of a glance would be far worse than a stale badge.
      expect(screen.getByRole('menuitem', { name: /overdue follow-ups/i })).toBeInTheDocument();
      expect(
        screen.getByRole('menuitem', { name: /conversations needing review/i }),
      ).toBeInTheDocument();
    });

    it('comes back when a count rises', async () => {
      const user = userEvent.setup();
      const { rerender } = renderMenu();

      await user.click(screen.getByRole('button', { name: /need attention/i }));
      await screen.findByRole('button', { name: /nothing needs attention/i });

      // One more overdue follow-up than when they looked.
      rerender(
        <MemoryRouter>
          <NotificationsMenu
            items={items.map((item) =>
              item.id === 'overdue' ? { ...item, count: item.count + 1 } : item,
            )}
          />
        </MemoryRouter>,
      );

      // Only the DIFFERENCE, not the whole total again.
      expect(
        await screen.findByRole('button', { name: /1 item need attention/i }),
      ).toBeInTheDocument();
    });
  });

  it('does not claim to be a message history', async () => {
    // It reflects what is true now and has nothing to mark as read. Saying so
    // is cheaper than someone filing a bug about missing notifications.
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: /need attention/i }));
    expect(screen.getByText(/live counts, not a message history/i)).toBeInTheDocument();
  });
});
