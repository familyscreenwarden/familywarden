import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProvider } from './app';
import { AppRoutes } from './routes';
import type { FetchLike } from './api/client';
import './styles.css';

async function start() {
  // VITE_MOCK=1 swaps the network for in-memory fixtures (see api/mock.ts).
  const fetchFn: FetchLike = import.meta.env.VITE_MOCK === '1'
    ? (await import('./api/mock')).createMockFetch(window.location.search)
    : (input, init) => window.fetch(input, init);

  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root');
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <AppProvider fetchFn={fetchFn}>
          <AppRoutes />
        </AppProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}

void start();
