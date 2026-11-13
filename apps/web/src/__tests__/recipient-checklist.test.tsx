import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmailAudiencePreview } from '@leadflow/api-types';

import {
  CityChecklist,
  ConfirmDialog,
  RecipientChecklist,
  TRUNCATION_WARNING,
} from '../features/email/campaign-editor-page';
import * as apiClient from '../lib/api-client';

/**
 * The campaign recipient filters: one checkbox per address (deselect to leave
 * someone out), city checkboxes, and — at the 1,000-address display limit —
 * an unmistakable statement that undisplayed recipients still receive it.
 */

afterEach(() => vi.restoreAllMocks());

const person = (
  i: number,
  excluded = false,
  ineligible: 'NO_CONSENT' | 'SUPPRESSED' | null = null,
) => ({
  email: `a${String(i).padStart(4, '0')}@cust.example`,
  name: `Person ${i}`,
  company: null,
  excluded,
  ineligible,
});
/** Cheap count: role queries over 1,000 inputs are slow under a parallel run. */
const boxCount = () => document.querySelectorAll('input[type="checkbox"]').length;
const listOf = (n: number) => Array.from({ length: Math.min(n, 1000) }, (_, i) => person(i));

const checklist = (n: number, excluded: string[] = [], onChange = vi.fn()) => {
  render(
    <RecipientChecklist
      recipients={listOf(n)}
      truncated={n > 1000}
      eligible={n - excluded.length}
      total={n}
      undisplayedEligible={Math.max(0, n - 1000)}
      excluded={excluded}
      onChange={onChange}
    />,
  );
  return onChange;
};

describe('RecipientChecklist at the 1,000-address boundary', { timeout: 20_000 }, () => {
  it.each([
    [999, false],
    [1000, false],
  ])('%i matching: all displayed, no truncation warning', (n) => {
    checklist(n);
    expect(boxCount()).toBe(n);
    expect(screen.getByText(`${n} of ${n} displayed selected`)).toBeInTheDocument();
    expect(screen.queryByText(TRUNCATION_WARNING)).not.toBeInTheDocument();
  });

  it.each([
    [1001, 1],
    [1500, 500],
  ])(
    '%i matching: 1,000 displayed, the warning, and %i not displayed who still receive it',
    (n, rest) => {
      checklist(n);
      expect(boxCount()).toBe(1000);
      expect(screen.getByText(TRUNCATION_WARNING)).toBeInTheDocument();
      expect(screen.getByTestId('total-eligible')).toHaveTextContent(String(n));
      expect(screen.getByTestId('not-displayed')).toHaveTextContent(String(rest));
      expect(screen.getByRole('alert')).toHaveTextContent(
        `${rest} recipients who are not displayed will still receive`,
      );
    },
  );

  it('"Deselect all displayed" with 1,500 matching deselects only the 1,000 shown; 500 are still said to receive it', async () => {
    const user = userEvent.setup();
    const onChange = checklist(1500);
    await user.click(screen.getByRole('button', { name: 'Deselect all displayed' }));
    const sent = onChange.mock.lastCall![0] as string[];
    expect(sent).toHaveLength(1000);
    expect(screen.getByRole('alert')).toHaveTextContent(
      '500 recipients who are not displayed will still receive',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('does not reach them');
  });

  it('per-address deselect and reselect; search narrows what the bulk actions touch', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RecipientChecklist
        recipients={[person(1), person(2), person(3, true)]}
        truncated={false}
        eligible={2}
        total={3}
        undisplayedEligible={0}
        excluded={[person(3).email]}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('2 of 3 displayed selected')).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    await user.click(boxes[0]!);
    expect(onChange).toHaveBeenLastCalledWith([person(3).email, person(1).email]);
    await user.click(boxes[2]!);
    expect(onChange).toHaveBeenLastCalledWith([]);
    await user.type(screen.getByRole('searchbox', { name: 'Search recipients' }), 'Person 2');
    await user.click(screen.getByRole('button', { name: 'Select all displayed' }));
    expect(onChange).toHaveBeenLastCalledWith([person(3).email]);
  });
});

describe('every matching lead is listed, ticked by default', () => {
  it('new leads without recorded eligibility still appear, ticked, with the reason; unticking excludes one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RecipientChecklist
        recipients={[person(1, false, 'NO_CONSENT'), person(2, false, 'NO_CONSENT'), person(3)]}
        truncated={false}
        eligible={1}
        total={3}
        undisplayedEligible={0}
        excluded={[]}
        onChange={onChange}
      />,
    );
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    expect(
      screen.getAllByText('Cannot receive yet: no recorded marketing eligibility'),
    ).toHaveLength(2);
    expect(screen.getByText(/2 ticked leads cannot receive this campaign yet/)).toBeInTheDocument();
    await user.click(boxes[1]!);
    expect(onChange).toHaveBeenLastCalledWith([person(2).email]);
  });

  it('a suppressed lead is labelled as such', () => {
    render(
      <RecipientChecklist
        recipients={[person(1, false, 'SUPPRESSED')]}
        truncated={false}
        eligible={0}
        total={1}
        undisplayedEligible={0}
        excluded={[]}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByText('Cannot receive: unsubscribed, bounced or suppressed'),
    ).toBeInTheDocument();
  });
});

describe('ConfirmDialog states who receives it', { timeout: 20_000 }, () => {
  const preview = (over: Partial<EmailAudiencePreview>): EmailAudiencePreview => ({
    selected: 0,
    eligible: 0,
    excluded: { INVALID: 0, SUPPRESSED: 0, NO_CONSENT: 0, DUPLICATE: 0, EXCLUDED: 0 },
    sample: [],
    recipients: [],
    recipientsTruncated: false,
    recipientsListed: true,
    recipientsTotal: 0,
    undisplayedEligible: 0,
    ...over,
  });
  const open = (audience: EmailAudiencePreview, confirm?: () => Promise<unknown>) => {
    const post = vi
      .spyOn(apiClient, 'apiPost')
      .mockImplementation((url: string) =>
        url.endsWith('/audience')
          ? Promise.resolve(audience)
          : (confirm?.() ?? Promise.resolve({ id: 'c1' })),
      );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConfirmDialog campaignId="c1" purpose="PROMOTIONAL" filter={{}} onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return post;
  };

  it('says plainly, before the Send button, that this is the real campaign and NOT a test email', async () => {
    open(preview({ selected: 2, eligible: 2, recipientsTotal: 2 }));
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(
      'This sends the actual campaign to the selected recipients. It is NOT a test email. To send a test, cancel and use the Test email section.',
    );
    const send = await screen.findByRole('button', { name: /^Send to 2$/ });
    // The warning comes first in the dialog, ahead of the button.
    expect(note.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('after "Deselect all displayed" with 1,500 matching: shows 500 will still receive it and requires an explicit acknowledgement', async () => {
    const user = userEvent.setup();
    const post = open(
      preview({
        selected: 1500,
        eligible: 500,
        excluded: { INVALID: 0, SUPPRESSED: 0, NO_CONSENT: 0, DUPLICATE: 0, EXCLUDED: 1000 },
        recipients: listOf(1000).map((p) => ({ ...p, excluded: true })),
        recipientsTruncated: true,
        recipientsTotal: 1500,
        undisplayedEligible: 500,
      }),
    );
    const breakdown = await screen.findByLabelText('Audience breakdown');
    expect(breakdown).toHaveTextContent('Total eligible recipients500');
    expect(breakdown).toHaveTextContent('Displayed in the list1000');
    expect(breakdown).toHaveTextContent('Not displayed500');
    expect(breakdown).toHaveTextContent('Excluded by hand1000');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '500 recipients not displayed in the list will receive this campaign',
    );
    const sendButton = screen.getByRole('button', { name: 'Send to 500' });
    expect(sendButton).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /I understand that 500 recipients/ }));
    expect(sendButton).toBeEnabled();
    await user.click(sendButton);
    expect(post).toHaveBeenCalledWith(
      '/email/campaigns/c1/confirm',
      expect.objectContaining({ eligibleCount: 500 }),
    );
  });

  it('with everyone displayed, no acknowledgement is needed', async () => {
    open(preview({ selected: 999, eligible: 999, recipients: listOf(999), recipientsTotal: 999 }));
    expect(await screen.findByRole('button', { name: 'Send to 999' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('for a role that may not see addresses, says everyone eligible will receive it', async () => {
    open(
      preview({
        eligible: 12,
        recipientsListed: false,
        recipientsTotal: 12,
        undisplayedEligible: 12,
      }),
    );
    expect(
      await screen.findByText(/address list is not available to your role; all 12/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to 12' })).toBeEnabled();
  });

  it('if the audience changed after the preview, the server refusal is shown and nothing is sent', async () => {
    const user = userEvent.setup();
    open(preview({ eligible: 3, recipients: listOf(3), recipientsTotal: 3 }), () =>
      Promise.reject(
        new apiClient.ApiError(
          'CONFLICT',
          'The audience changed: 2 recipients are eligible now, not 3. Review and confirm again.',
          409,
        ),
      ),
    );
    await user.click(await screen.findByRole('button', { name: 'Send to 3' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The audience changed: 2 recipients'),
    );
  });
});

describe('CityChecklist', () => {
  const cities = [
    { name: 'Pune', count: 12 },
    { name: 'Mumbai', count: 7 },
  ];

  it('ticking adds a city, unticking removes it regardless of case', async () => {
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
