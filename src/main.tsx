import { createRoot } from 'react-dom/client';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  if (location.pathname === '/diagnostics') {
    const { App } = await import('./App');
    await import('./styles.css');
    root.render(<App />);
  } else {
    const { ProductApp } = await import('./ui/ProductApp');
    root.render(<ProductApp />);
  }
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Local data remains in IndexedDB; do not falsely claim that the shell is cached.
      document.documentElement.dataset.offlineShell = 'unavailable';
    });
  }
}
start().catch(() => {
  const root = document.getElementById('root')!;
  root.textContent = 'RelayTrace could not start. Your local data has not been deleted. Check the browser console and local configuration, then reload.';
});
