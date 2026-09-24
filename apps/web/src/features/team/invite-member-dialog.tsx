import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ROLE_KEYS, type InviteUserResponse, type RoleKey } from '@leadflow/api-types';
import { ApiError, apiPost } from '../../lib/api-client';
import { humanise } from '../../lib/format';
import { useAuth } from '../auth/auth-context';

/**
 * Invite dialog.
 *
 * Only an OWNER may invite another OWNER — the same rule the API enforces.
 * Showing a role the server will refuse would produce an error the user cannot
 * act on, so the option is simply absent.
 */
export function InviteMemberDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<RoleKey>('SALES_REP');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  /**
   * Set when the invitation exists but its email was NOT accepted.
   *
   * A distinct state from success and from failure, because it is genuinely a
   * third outcome: the person is invited and can be resent, but nobody has
   * been told yet. Claiming "invitation sent" here is what hid a broken mail
   * transport for as long as it was hidden.
   */
  const [undelivered, setUndelivered] = useState(false);
  const [copied, setCopied] = useState(false);

  const dialog = useRef<HTMLDivElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);

  /**
   * Focus management: remember what opened the dialog, move focus in, trap Tab
   * inside it, and restore focus on close. Without this a keyboard user tabs
   * into the page behind the overlay.
   */
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    firstField.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialog.current?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href]',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      (opener.current as HTMLElement | null)?.focus();
    };
  }, [open, onClose]);

  const invite = useMutation({
    mutationFn: () => apiPost<InviteUserResponse>('/users/invite', { email, fullName, role }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['invitations'] });

      // Outside production the API returns the token so the flow is testable
      // without an email provider. Surfacing it here is what makes the invite
      // usable in local development.
      if (result.inviteToken) {
        setInviteLink(`${window.location.origin}/invite/${result.inviteToken}`);
        return;
      }

      if (!result.emailDelivered) {
        // The invitation is real; the email is not. Hold the dialog open and
        // say exactly that rather than closing as though it had been sent.
        setUndelivered(true);
        return;
      }

      onClose();
    },
  });

  if (!open) return null;

  const assignable = ROLE_KEYS.filter((key) => key !== 'OWNER' || user?.role === 'OWNER');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    invite.mutate();
  };

  const reset = (): void => {
    setEmail('');
    setFullName('');
    setRole('SALES_REP');
    setInviteLink(null);
    setUndelivered(false);
    setCopied(false);
    onClose();
  };

  const fieldError = (name: string): string | undefined =>
    invite.error instanceof ApiError ? invite.error.details?.[name]?.[0] : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        className="my-8 w-full max-w-md rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 id="invite-title" className="text-sm font-semibold text-slate-900">
            Invite a team member
          </h2>
          <button
            type="button"
            onClick={reset}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        {undelivered ? (
          <div className="space-y-4 p-5">
            <p
              role="alert"
              className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              The invitation for <strong className="font-medium">{email}</strong> was
              created, but the email could not be delivered. They have not been
              notified yet — use <strong className="font-medium">Resend</strong> from the
              pending list to try again.
            </p>
            <button
              type="button"
              onClick={reset}
              className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Close
            </button>
          </div>
        ) : inviteLink ? (
          <div className="space-y-4 p-5">
            <p role="status" aria-live="polite" className="text-sm text-slate-700">
              Invitation created for <strong className="font-medium">{email}</strong>.
            </p>
            <div>
              <label htmlFor="invite-link" className="mb-1 block text-sm font-medium text-slate-700">
                Invitation link
              </label>
              <div className="flex gap-2">
                <input
                  id="invite-link"
                  readOnly
                  value={inviteLink}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700"
                />
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(inviteLink);
                    setCopied(true);
                  }}
                  className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Send this to {email}. It can be used once and expires in 7 days.
              </p>
            </div>
            <button
              type="button"
              onClick={reset}
              className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4 p-5" noValidate>
            <div>
              <label htmlFor="invite-email" className="mb-1 block text-sm font-medium text-slate-700">
                Email <span className="text-red-500">*</span>
              </label>
              <input
                ref={firstField}
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={fieldError('email') ? true : undefined}
                className={inputClass}
              />
              {fieldError('email') && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {fieldError('email')}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="invite-name" className="mb-1 block text-sm font-medium text-slate-700">
                Full name <span className="text-red-500">*</span>
              </label>
              <input
                id="invite-name"
                required
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="invite-role" className="mb-1 block text-sm font-medium text-slate-700">
                Role
              </label>
              <select
                id="invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value as RoleKey)}
                className={inputClass}
              >
                {assignable.map((key) => (
                  <option key={key} value={key}>
                    {humanise(key)}
                  </option>
                ))}
              </select>
              {user?.role !== 'OWNER' && (
                <p className="mt-1 text-xs text-slate-400">Only an owner can invite another owner.</p>
              )}
            </div>

            {invite.isError && (
              <p role="alert" aria-live="assertive" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {invite.error instanceof ApiError ? invite.error.message : 'Could not send the invitation.'}
              </p>
            )}

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
              <button
                type="button"
                onClick={reset}
                className="rounded-lg px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={invite.isPending}
                aria-busy={invite.isPending}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
              >
                {invite.isPending ? 'Sending…' : 'Send invitation'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900';
