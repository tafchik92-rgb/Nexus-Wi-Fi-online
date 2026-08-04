import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

// NEXUS//POS ships as plain (non-module) scripts sharing globals, so Vite
// cannot bundle them and drops them from the build. Copy them into dist
// verbatim, otherwise the built page loads no JavaScript at all.
const STATIC_SCRIPTS = [
  'firebase-config.js', 'sw.js', 'manifest.webmanifest',
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
    // Teach the service worker the hashed asset names Vite just produced,
    // so the precache covers the built CSS rather than the source filename.
    const swOut = path.resolve(out, 'sw.js');
    const htmlOut = path.resolve(out, 'index.html');
    if (fs.existsSync(swOut) && fs.existsSync(htmlOut)) {
      const html = fs.readFileSync(htmlOut, 'utf8');
      const assets = [...html.matchAll(/(?:href|src)="\.?\/?(assets\/[^"]+)"/g)]
        .map((m) => `"./${m[1]}"`);
      let sw = fs.readFileSync(swOut, 'utf8');
      if (assets.length) sw = sw.replace('/*__BUILD_ASSETS__*/', assets.join(', '));
      sw = sw.replace('/*__BUILD_TIME__*/', Date.now().toString(36));
      fs.writeFileSync(swOut, sw);
    }

    const icons = path.resolve(__dirname, 'icons');
    if (fs.existsSync(icons)) {
      fs.mkdirSync(path.resolve(out, 'icons'), {recursive: true});
      for (const f of fs.readdirSync(icons)) {
        fs.copyFileSync(path.resolve(icons, f), path.resolve(out, 'icons', f));
      }
    }
  },
});

export default defineConfig(() => {
  return {
    plugins: [copyStaticScripts()],
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
