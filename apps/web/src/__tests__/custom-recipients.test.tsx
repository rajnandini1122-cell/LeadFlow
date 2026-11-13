import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CustomEmailList, parseEmailList } from '../features/email/campaign-editor-page';

/**
 * Sending to a custom list: one address or many, typed or pasted. Only
 * well-formed addresses are kept; the rest are shown so they can be fixed.
 */

describe('parseEmailList', () => {
  it('accepts one address', () => {
    expect(parseEmailList('Asha@Example.com')).toEqual({ valid: ['asha@example.com'], invalid: [] });
  });

  it('splits on commas, semicolons, spaces and new lines; lowercases and de-duplicates', () => {
    expect(
      parseEmailList('a@x.example, b@x.example;c@x.example\nd@x.example  A@X.example\n\n'),
    ).toEqual({
      valid: ['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example'],
      invalid: [],
    });
  });

  it('keeps malformed entries apart, and strips <angle brackets>', () => {
    expect(parseEmailList('<ok@x.example>, not-an-email, @x.example, x@nodot')).toEqual({
      valid: ['ok@x.example'],
      invalid: ['not-an-email', '@x.example', 'x@nodot'],
    });
  });
});

describe('CustomEmailList', () => {
  it('reports the count, passes only valid addresses on, and shows the invalid ones', () => {
    const onChange = vi.fn();
    render(<CustomEmailList value={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Email addresses'), {
      target: { value: 'one@x.example, two@x.example\nbad-address' },
    });
    expect(onChange).toHaveBeenLastCalledWith(['one@x.example', 'two@x.example']);
    expect(screen.getByTestId('custom-count')).toHaveTextContent('2 addresses');
    expect(screen.getByRole('alert')).toHaveTextContent('Not a valid address, left out: bad-address');
  });

  it('a single address works', () => {
    const onChange = vi.fn();
    render(<CustomEmailList value={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Email addresses'), {
      target: { value: 'buyer@cust.example' },
    });
    expect(onChange).toHaveBeenLastCalledWith(['buyer@cust.example']);
    expect(screen.getByTestId('custom-count')).toHaveTextContent('1 address');
  });

  it('shows a saved list when reopened', () => {
    render(<CustomEmailList value={['a@x.example', 'b@x.example']} onChange={() => {}} />);
    expect(screen.getByLabelText('Email addresses')).toHaveValue('a@x.example\nb@x.example');
  });
});
