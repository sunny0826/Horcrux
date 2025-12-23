import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const getGitVersion = () => {
  try {
    const tag = execSync('git describe --tags --exact-match', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (tag) return tag;
  } catch {
    // ignore
  }

  try {
    const hash = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (hash) return hash;
  } catch {
    // ignore
  }

  return 'DEV';
};

const appVersion = getGitVersion();

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 7627,
    strictPort: true,
    hmr: {
      clientPort: 7626,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:7626',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
