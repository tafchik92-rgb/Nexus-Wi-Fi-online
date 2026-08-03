import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

// NEXUS//POS ships as plain (non-module) scripts sharing globals, so Vite
// cannot bundle them and drops them from the build. Copy them into dist
// verbatim, otherwise the built page loads no JavaScript at all.
const STATIC_SCRIPTS = [
  'importer.js', 'backend.js', 'core.js', 'admin.js', 'agent.js', 'app.js',
];

const copyStaticScripts = () => ({
  name: 'copy-static-scripts',
  closeBundle() {
    const out = path.resolve(__dirname, 'dist');
    fs.mkdirSync(out, {recursive: true});
    for (const file of STATIC_SCRIPTS) {
      const from = path.resolve(__dirname, file);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.resolve(out, file));
    }
  },
});

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), copyStaticScripts()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
