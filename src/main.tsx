import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import './assets/fonts/lionlabs-grotesk/font-switch.css';
try {
  document.documentElement.dataset.uifont = localStorage.getItem('lionlabs:uifont') || 'lionlabs';
} catch {
  document.documentElement.dataset.uifont = 'lionlabs';
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
