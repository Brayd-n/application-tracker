import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  // `npm run dev` (API on :3000) + `npm run dev:web` (this, on :5173)
  server: { proxy: { '/api': 'http://localhost:3000', '/auth': 'http://localhost:3000' } },
});
