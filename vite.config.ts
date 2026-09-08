import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    base: './',
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
    },
  };
});
