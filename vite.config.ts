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
