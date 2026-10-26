import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { installNativeShell } from './lib/native-shell';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

/*
 * Tells the startup shell that the bundle arrived.
 *
 * Set BEFORE render rather than after, because the point is "the JavaScript
 * loaded", not "the first screen is ready" — the shell's timeout exists to
 * distinguish a broken download from a slow one, and React taking a moment to
 * mount is not the failure it is watching for.
 *
 * The shell itself needs no removal: createRoot() replaces the container's
 * contents when it renders.
 */
document.documentElement.setAttribute('data-booted', '');

// Android: hardware Back and refresh-on-resume. Nothing in a browser.
void installNativeShell();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
