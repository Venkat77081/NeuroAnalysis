import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './i18n/index.ts';
import { App } from './App.tsx';
import { capture } from './lib/capture.ts';
import { crashScreen, installCrashReporter } from './lib/crash.ts';

installCrashReporter(capture.kit, () => crashScreen.get());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
