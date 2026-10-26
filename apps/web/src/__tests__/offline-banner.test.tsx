import { act, render, screen } from '@testing-library/react';
import { onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { OfflineBanner } from '../components/offline-banner';

/**
 * Offline, saves are held and sent on reconnect. The rep must be told — on a
 * phone it otherwise looks like a save stuck on "Saving…" forever.
 */
afterEach(() => {
  act(() => onlineManager.setOnline(true));
});

describe('OfflineBanner', () => {
  it('appears offline, says what happens to saves, and disappears on reconnect', () => {
    render(<OfflineBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => onlineManager.setOnline(false));
    expect(screen.getByRole('status')).toHaveTextContent(/offline.*sent as soon as you’re back online/i);

    act(() => onlineManager.setOnline(true));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
