import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const apiTarget = process.env.API_URL ?? 'http://localhost:8090';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registered from main.tsx so the page reloads itself when a new version is deployed.
      injectRegister: false,
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'PrintHub',
        short_name: 'PrintHub',
        description: 'Verwaltung und Überwachung der 3D-Drucker',
        lang: 'de',
        start_url: '/',
        display: 'standalone',
        background_color: '#121211',
        theme_color: '#121211',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Own service worker (src/sw.ts) for push notifications; Workbox injects the precache list.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, ws: true, changeOrigin: false },
    },
  },
});
