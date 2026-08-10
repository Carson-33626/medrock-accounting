// The program has no '@/*' alias — that was the web app's. This config exists to scope the run
// to the program and keep cache/ (≈360 MB of PDFs) out of the file watcher.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'cache/**'],
  },
});
