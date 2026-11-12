import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CityChecklist, RecipientChecklist } from '../features/email/campaign-editor-page';

/**
 * The campaign recipient filters: one checkbox per address (untick to leave
 * someone out, tick to put them back) and one per city from the
 * organization's own leads.
 */

const people = [
  { email: 'asha@cust.example', name: 'Asha Rao', company: 'Rao Traders', excluded: false },
  { email: 'bina@cust.example', name: 'Bina Shah', company: null, excluded: false },
  { email: 'chetan@cust.example', name: null, company: 'Chetan & Co', excluded: true },
];

describe('RecipientChecklist', () => {
  it('ticks everyone not left out, and unticking leaves that address out', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RecipientChecklist
        recipients={people}
        truncated={false}
        excluded={['chetan@cust.example']}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('2 of 3 ticked')).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, true, false]);

    await user.click(boxes[0]!);
    expect(onChange).toHaveBeenLastCalledWith(['chetan@cust.example', 'asha@cust.example']);
    await user.click(boxes[2]!);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('search narrows the list, and Untick/Tick act on what is shown', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<RecipientChecklist recipients={people} truncated excluded={[]} onChange={onChange} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search recipients' }), 'shah');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Untick shown' }));
    expect(onChange).toHaveBeenLastCalledWith(['bina@cust.example']);
    expect(screen.getByText(/Showing the first 3/)).toBeInTheDocument();
  });
});

describe('CityChecklist', () => {
  const cities = [
    { name: 'Pune', count: 12 },
    { name: 'Mumbai', count: 7 },
  ];

  it('shows each city with its count; ticking adds it, unticking removes it regardless of case', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<CityChecklist cities={cities} value={[]} onChange={onChange} />);
    expect(screen.getByText(/none ticked = every city/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Pune/ }));
    expect(onChange).toHaveBeenLastCalledWith(['Pune']);

    rerender(<CityChecklist cities={cities} value={['pune']} onChange={onChange} />);
    expect(screen.getByRole('checkbox', { name: /Pune/ })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: /Pune/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('says so when no lead has a city', () => {
    render(<CityChecklist cities={[]} value={[]} onChange={() => undefined} />);
    expect(screen.getByText(/No lead with an email has a city yet/)).toBeInTheDocument();
  });
});
