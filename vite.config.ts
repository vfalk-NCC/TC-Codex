import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base path must match the GitHub Pages URL used in public/manifest.json.
export default defineConfig({
  base: '/TC-Codex/',
  plugins: [react()],
});
