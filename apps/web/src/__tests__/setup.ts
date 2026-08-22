import '@testing-library/jest-dom/vitest';

/*
 * jsdom has no layout, so `window.scrollTo` is unimplemented and every route
 * change logs a "Not implemented" warning. The app calls it deliberately — see
 * ScrollToTop — so the warning is noise rather than a signal, and drowning real
 * output in it is how real output gets ignored.
 *
 * Stubbed, not silenced: scroll-to-top.test.tsx replaces this with its own spy
 * and asserts on the arguments, so the behaviour is still covered.
 */
window.scrollTo = () => {};
