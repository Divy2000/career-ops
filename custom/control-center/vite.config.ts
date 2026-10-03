import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: `${here}web`,
  plugins: [react()],
  build: {
    outDir: `${here}dist`,
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@shared': `${here}shared`,
      '@web': `${here}web`,
    },
  },
});
