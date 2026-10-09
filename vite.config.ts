import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/TC-Codex/',
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@ifc-lite/wasm'] },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
