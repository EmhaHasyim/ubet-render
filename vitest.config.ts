import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    solidPlugin({
      // Disable HMR in test mode — prevents "@solid-refresh" error
      hot: false,
    }),
    tailwindcss(),
  ],
  test: {
    // Default is `happy-dom`: measured ~25% faster than jsdom on this suite
    // (438/438 green, no env-specific mocks) after the dropzone logic was
    // extracted to pure, simulator-agnostic units. Pure-logic files opt out
    // further with a `// @vitest-environment node` lead comment (only if
    // they never touch document/window/localStorage, directly or via
    // imports); the shared setup file is node-safe (DOM shims are guarded).
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
