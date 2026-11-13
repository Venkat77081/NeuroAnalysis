import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset paths so the build works inside the Capacitor WebView.
  base: './',
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/session/**/*.ts'],
      // DEV_PLAN M3: the state machine has ≥ 90 % branch coverage.
      thresholds: { branches: 90, lines: 90, functions: 90, statements: 90 },
    },
  },
});
