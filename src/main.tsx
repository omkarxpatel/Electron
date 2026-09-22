import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Tag the document with the host platform so CSS can mirror the window chrome:
// macOS puts its traffic lights top-LEFT, Windows puts its caption buttons
// top-RIGHT, and `.topbar` has to reserve its gutter on the matching side.
// Defaults to darwin so a plain browser (vite dev without Electron) keeps the
// existing layout rather than falling into the Windows branch.
document.documentElement.dataset.platform = window.api?.platform ?? 'darwin';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
