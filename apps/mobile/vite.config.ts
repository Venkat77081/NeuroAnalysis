import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset paths so the build works inside the Capacitor WebView.
  base: './',
  build: { outDir: 'dist', sourcemap: false },
  test: { include: ['test/**/*.test.ts'] },
});
