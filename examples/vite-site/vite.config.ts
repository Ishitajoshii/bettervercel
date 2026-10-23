import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs keep JS/CSS working under any /d/<deployment-id>/ prefix.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
