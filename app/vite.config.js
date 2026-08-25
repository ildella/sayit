import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  // Tauri dev expects a fixed port and no host rewriting.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
