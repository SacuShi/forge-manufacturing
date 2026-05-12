/**
 * FORGE v1.0 — Application entry point
 *
 * CSS import order is critical — each layer references variables from the
 * previous one, so they must be loaded in this exact sequence:
 *   1. variables.css  — CSS custom properties (design tokens)
 *   2. global.css     — Reset, app-shell layout, scrollbar, utility classes
 *   3. components.css — All component-specific styles
 *
 * The root element #root is asserted to exist; an explicit error is thrown
 * (rather than a silent null-render) so misconfigured deployments fail loudly.
 */

import { StrictMode } from 'react';
import { createRoot }  from 'react-dom/client';

import './styles/variables.css';
import './styles/global.css';
import './styles/components.css';

import App from './App';

const rootEl = document.getElementById('root');

if (!rootEl) {
  throw new Error(
    '[FORGE] Root element #root not found — verify index.html contains <div id="root"></div>'
  );
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
