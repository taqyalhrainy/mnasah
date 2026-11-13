import { RecoveryBoundary } from './app/RecoveryBoundary';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ExternalBrowserGate } from './app/ExternalBrowserGate';
import './styles/global.css';
import './styles/design.css';
import './styles/purple.css';
import './styles/preferences.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RecoveryBoundary><ExternalBrowserGate><App /></ExternalBrowserGate></RecoveryBoundary>
  </StrictMode>,
);

// Recovery is a one-shot network navigation, not a permanent application URL.
const launchUrl = new URL(location.href);
if (launchUrl.searchParams.has('__app_reload')) {
  launchUrl.searchParams.delete('__app_reload');
  history.replaceState(history.state, '', `${launchUrl.pathname}${launchUrl.search}${launchUrl.hash}`);
}

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`, { updateViaCache: 'none' }).catch(() => undefined);
}
