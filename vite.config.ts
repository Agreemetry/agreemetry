import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// BASE_PATH is set by the GitHub Pages workflow to "/<repository>/"; local builds use "./".
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 60000 },
});
