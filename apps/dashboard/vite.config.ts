import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Static files, deployable under any path next to the API (PLATFORM_PLAN M14).
  base: './',
  build: { outDir: 'dist', sourcemap: false },
  test: { include: ['test/**/*.test.ts'] },
});
