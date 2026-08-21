import { useEffect } from 'react';

/**
 * Sets the document title and meta description for a route.
 *
 * A hook rather than a framework. react-helmet and friends exist to solve
 * server-side rendering, which this application does not do — for a client
 * rendered SPA, setting two DOM properties is the whole job, and a dependency
 * would be more code to keep working than the four lines it replaces.
 *
 * HONEST LIMITATION: because this runs after hydration, a crawler that does not
 * execute JavaScript sees only the static tags in index.html. That is fine for
 * a link shared with a prospect and not fine for ranking in search. Fixing it
 * properly means prerendering the marketing routes at build time, which is a
 * deliberately separate piece of work.
 */
export function usePageMeta(title: string, description?: string): void {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;

    let element: HTMLMetaElement | null = null;
    let previousDescription: string | null = null;

    if (description) {
      element = document.querySelector('meta[name="description"]');
      if (element) {
        previousDescription = element.getAttribute('content');
        element.setAttribute('content', description);
      }
    }

    // Restored on unmount so navigating away from a marketing page does not
    // leave its description attached to the authenticated app.
    return () => {
      document.title = previousTitle;
      if (element && previousDescription !== null) {
        element.setAttribute('content', previousDescription);
      }
    };
  }, [title, description]);
}
