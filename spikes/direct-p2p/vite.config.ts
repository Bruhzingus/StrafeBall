import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig(({ command }) => ({
  root: resolve(__dirname),
  base: command === 'serve' ? '/' : '/p2p-spike/',
  publicDir: resolve(__dirname, '../../public'),
  server: { host: '127.0.0.1', port: 5174, fs: { allow: [resolve(__dirname, '../..')] } },
  build: { outDir: resolve(__dirname, '../../dist/p2p-spike'), emptyOutDir: true, copyPublicDir: false }
}));
