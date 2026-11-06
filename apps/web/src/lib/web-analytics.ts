import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { apiBaseUrl, isNativeApp } from './platform';

/**
 * First-party analytics for the PUBLIC LeadFlow website.
 *
 * What it sends: the event, the public path (no query string), the referring
 * page (the server keeps only its host), any utm_source / utm_medium, and two
 * random ids kept in localStorage -- one per browser, one per visit (a visit
 * ends after 30 minutes without activity). The server stores the ids only as
 * keyed hashes and records no IP address.
 *
 * What it never does: run in the Android app or the signed-in CRM, set a
 * cookie, load a third-party script, or send form contents. It sends nothing
 * when the browser asks not to be tracked (Do Not Track / Global Privacy
 * Control), and a failure is silently ignored.
 */
export type WebAnalyticsEvent = 'page_view' | 'registration_start' | 'registration_complete' | 'contact_submit';

const VISITOR_KEY = 'leadflow.wa.visitor';
const SESSION_KEY = 'leadflow.wa.session';
const SESSION_IDLE_MS = 30 * 60 * 1000;

function trackingAllowed(): boolean {
  if (typeof window === 'undefined' || isNativeApp()) return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  const dnt = nav.doNotTrack ?? (window as Window & { doNotTrack?: string }).doNotTrack ?? nav.msDoNotTrack;
  if (dnt === '1' || dnt === 'yes' || nav.globalPrivacyControl === true) return false;
  return true;
}

function storedId(key: string, freshIf?: (saved: { id: string; at: number }) => boolean): string | null {
  try {
    const raw = localStorage.getItem(key);
    const saved = raw ? (JSON.parse(raw) as { id: string; at: number }) : null;
    const id = saved && !(freshIf?.(saved) ?? false) ? saved.id : crypto.randomUUID();
    localStorage.setItem(key, JSON.stringify({ id, at: Date.now() }));
    return id;
  } catch {
    return null; // storage blocked: send nothing rather than invent a visitor per page
  }
}

export function trackWebEvent(event: WebAnalyticsEvent, path: string = window.location.pathname): void {
  if (!trackingAllowed()) return;
  const visitorId = storedId(VISITOR_KEY);
  const sessionId = storedId(SESSION_KEY, (s) => Date.now() - s.at > SESSION_IDLE_MS);
  if (!visitorId || !sessionId) return;

  const params = new URLSearchParams(window.location.search);
  const body = JSON.stringify({
    event,
    path,
    ...(document.referrer ? { referrer: document.referrer.slice(0, 500) } : {}),
    ...(params.get('utm_source') ? { utmSource: params.get('utm_source')?.slice(0, 60) } : {}),
    ...(params.get('utm_medium') ? { utmMedium: params.get('utm_medium')?.slice(0, 60) } : {}),
    visitorId,
    sessionId,
  });
  try {
    void fetch(`${apiBaseUrl()}/analytics/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'omit',
    }).catch(() => undefined);
  } catch {
    // Never affects the page.
  }
}

/** A page view for each public page shown. */
export function useTrackPageView(): void {
  const location = useLocation();
  useEffect(() => {
    trackWebEvent('page_view', location.pathname);
  }, [location.pathname]);
}
