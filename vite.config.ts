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
    watch: {
      // Never watch build output. vite-plugin-electron writes main.js into
      // dist-electron on every main-process build; with that directory
      // watched, the write itself looks like a source change, which triggers
      // another build, which respawns Electron — and killStaleInstances()
      // then SIGTERMs the previous instance. The result is a restart loop
      // that eventually takes the dev server down with it.
      //
      // `release/` is the packaged .app bundle: thousands of files vite has
      // no business scanning, and touching any of them forces a full page
      // reload that wipes renderer state mid-session.
      ignored: ['**/dist/**', '**/dist-electron/**', '**/release/**'],
    },
  },
  clearScreen: false,
});
