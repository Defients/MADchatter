import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {readFileSync, mkdirSync, copyFileSync, existsSync} from 'node:fs';
import {defineConfig, type Plugin} from 'vite';

const {version} = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * Serves the repo-root `og-image.png` at `/og-image.png` so the OG/Twitter
 * meta tags resolve to a stable URL without keeping a duplicate copy in
 * `public/`. The root file is the single source of truth.
 *   - Dev: a middleware serves the file for `GET /og-image.png`.
 *   - Build: `closeBundle` copies it into `dist/og-image.png`.
 */
function rootOgImage(): Plugin {
  const rootFile = path.resolve(__dirname, 'og-image.png');
  return {
    name: 'root-og-image',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method === 'GET' && req.url === '/og-image.png') {
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          try {
            res.end(readFileSync(rootFile));
          } catch {
            res.statusCode = 404;
            res.end();
          }
          return;
        }
        next();
      });
    },
    closeBundle() {
      if (!existsSync(rootFile)) return;
      const out = path.resolve(__dirname, 'dist', 'og-image.png');
      mkdirSync(path.dirname(out), {recursive: true});
      copyFileSync(rootFile, out);
    },
  };
}

export default defineConfig(() => {
  return {
    base: './',
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [react(), tailwindcss(), rootOgImage()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        '/api': 'http://localhost:3000',
      },
    },
    optimizeDeps: {
      exclude: ['@huggingface/transformers'],
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      rollupOptions: {
        output: {
          manualChunks: {
            // Split heavy vendor libs into separate chunks for better caching + parallel loading
            'vendor-react': ['react', 'react-dom', 'react-resizable-panels'],
            'vendor-icons': ['lucide-react'],
            'vendor-chat': ['tmi.js'],
            'vendor-ai': ['@anthropic-ai/sdk'],
          },
        },
      },
    },
  };
});
