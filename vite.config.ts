import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {readFileSync} from 'node:fs';
import {defineConfig} from 'vite';

const {version} = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig(() => {
  return {
    base: './',
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [react(), tailwindcss()],
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
