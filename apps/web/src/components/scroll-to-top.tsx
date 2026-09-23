import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Starts every new page at the top.
 *
 * A browser resets the scroll position on a real page load; a single-page app
 * does not, because the document never changes. So opening a lead from the
 * bottom of a long list drops you into the middle of the lead page, and going
 * back to a short page can leave you staring at blank space below its content.
 *
 * Keyed on `pathname` ONLY, deliberately. Search parameters change when a
 * filter, a tab or a page number changes, and those are things people adjust
 * while reading — yanking them back to the top mid-thought would be worse than
 * the problem this fixes.
 *
 * `instant` rather than smooth: this is a new screen, not a movement within
 * one, and animating it makes navigation feel slower than it is. It also
 * respects users who have asked for reduced motion without a special case.
 */
export function ScrollToTop(): null {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname]);

  return null;
}
