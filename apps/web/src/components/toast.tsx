import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Confirmation that an action happened.
 *
 * There was none. A dialog closed and the list silently re-sorted, so an agent
 * could not tell "saved" from "the dialog just closed" — and pressed the button
 * again. Every successful write now says what it did; every failure stays in its
 * dialog with the server's message, as before.
 *
 * One live region, announced politely, so a screen reader hears the same thing
 * a sighted user sees. No new dependency: this is a list and a timer.
 */

type Tone = 'success' | 'error';

interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** How long a confirmation stays up. Long enough to read, short enough not to pile up. */
const VISIBLE_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: Tone) => {
      const id = nextId.current++;
      // Newest last, at most three: a burst of saves should not bury the screen.
      setToasts((current) => [...current.slice(-2), { id, message, tone }]);
      window.setTimeout(() => dismiss(id), VISIBLE_MS);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push(message, 'success'),
      error: (message) => push(message, 'error'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg px-4 py-3 text-sm shadow-lg ring-1 ${
              toast.tone === 'success'
                ? 'bg-slate-900 text-white ring-slate-900'
                : 'bg-red-50 text-red-800 ring-red-200'
            }`}
          >
            <span aria-hidden className="mt-0.5">
              {toast.tone === 'success' ? '✓' : '!'}
            </span>
            <p className="flex-1">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className="-mr-1 rounded px-1 text-current opacity-70 transition hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * The toast API, or a silent no-op outside a provider — so a component rendered
 * in isolation (a test, a story) does not crash for want of a confirmation.
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

const NOOP: ToastApi = { success: () => undefined, error: () => undefined };
