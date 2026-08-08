import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

// NEXUS//POS ships as plain (non-module) scripts sharing globals, so Vite
// cannot bundle them and drops them from the build. Copy them into dist
// verbatim, otherwise the built page loads no JavaScript at all.
const STATIC_SCRIPTS = [
  'version.js', 'firebase-config.js', 'sw.js', 'manifest.webmanifest',
  'importer.js', 'backend.js', 'core.js', 'admin.js', 'agent.js', 'app.js',
];

// One stamp per build, in UTC, shared by the service worker's cache name and
// the version the app puts on screen. They have to be the same value: telling
// the two apart is how a till that is *serving* an old release from its own
// cache is distinguished from one that simply has not been updated yet.
const buildStamp = () => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

const copyStaticScripts = () => ({
  name: 'copy-static-scripts',
  closeBundle() {
    const out = path.resolve(__dirname, 'dist');
    const stamp = buildStamp();
    fs.mkdirSync(out, {recursive: true});
    for (const file of STATIC_SCRIPTS) {
      const from = path.resolve(__dirname, file);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.resolve(out, file));
    }

    // deploy.sh stamps the source tree before building (Firebase Hosting
    // serves that tree directly), so the placeholder may already be gone —
    // in which case leave the stamp it wrote rather than fighting over it.
    const verOut = path.resolve(out, 'version.js');
    if (fs.existsSync(verOut)) {
      fs.writeFileSync(verOut,
        fs.readFileSync(verOut, 'utf8').replace('__BUILD_STAMP__', stamp));
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
      sw = sw.replace('/*__BUILD_TIME__*/', stamp);
      fs.writeFileSync(swOut, sw);
    }

    const icons = path.resolve(__dirname, 'icons');
    if (fs.existsSync(icons)) {
      fs.mkdirSync(path.resolve(out, 'icons'), {recursive: true});
      for (const f of fs.readdirSync(icons)) {
        fs.copyFileSync(path.resolve(icons, f), path.resolve(out, 'icons', f));
      }
    }

    // Vite hashes the manifest into assets/. A manifest's relative URLs
    // resolve against the manifest's own location, so from there "icons/…"
    // becomes "/assets/icons/…", start_url becomes "/assets/index.html" and
    // scope becomes "/assets/" — none of which exist. The browser then
    // refuses to install the app at all. Point the link back at the copy
    // sitting beside index.html, where those paths mean what they say.
    if (fs.existsSync(htmlOut)) {
      const html = fs.readFileSync(htmlOut, 'utf8');
      const fixed = html.replace(
        /(<link[^>]*rel="manifest"[^>]*href=")[^"]*(")/,
        '$1manifest.webmanifest$2');
      if (fixed !== html) fs.writeFileSync(htmlOut, fixed);
      // and drop the stray hashed copy so there is only one manifest
      const assetsDir = path.resolve(out, 'assets');
      if (fs.existsSync(assetsDir)) {
        for (const f of fs.readdirSync(assetsDir)) {
          if (f.endsWith('.webmanifest')) fs.rmSync(path.resolve(assetsDir, f));
        }
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
