// Minimal vitest config: resolve the '@/*' path alias declared in tsconfig.json.
// Vite (and by extension Vitest) does not read tsconfig "paths" on its own, so
// without this, any test importing '@/...' fails to resolve at test time.
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
