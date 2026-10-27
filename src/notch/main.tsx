import React from 'react';
import ReactDOM from 'react-dom/client';
import { NotchPanel } from './NotchPanel';
import { ErrorBoundary } from '../components/ErrorBoundary';
import './notch.css';

// The HUD gets the same boundary the main window has had since 87cb42b.
// Unwrapped, a throw anywhere in NotchPanel unmounts the tree and leaves this
// window exactly as it is configured: transparent, always-on-top and
// click-through, with nothing drawn in it. There is no recreate path in
// electron/notchWindow.ts, so the only recovery is quitting the app — and
// since the panel is deliberately never occluded or throttled, it is the one
// renderer most likely to still be running when something goes wrong.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <NotchPanel />
    </ErrorBoundary>
  </React.StrictMode>,
);
