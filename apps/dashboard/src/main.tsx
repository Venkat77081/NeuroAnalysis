import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './i18n/index.ts';
import { loadConfig } from './api.ts';
import { App } from './App.tsx';
import { applyTheme, savedTheme } from './shell.tsx';

applyTheme(savedTheme());

void loadConfig().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
