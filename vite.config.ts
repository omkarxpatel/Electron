import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

// VSCode's integrated terminal sets ELECTRON_RUN_AS_NODE=1 so its own Electron
// runtime acts as Node. If we let that leak into our spawned Electron child,
// our app's main process runs as plain Node and `require("electron")` returns
// a path string instead of the API. Strip it from the dev/build environment.
delete process.env.ELECTRON_RUN_AS_NODE;

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
      },
      preload: {
        input: 'electron/preload.ts',
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  clearScreen: false,
});
