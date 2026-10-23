import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// E2E runs the real server in TEST MODE on a separate port with a throwaway data directory.
// Nothing is posted to YouTube and no AI key is used.
const PORT = 3100;
const dataDir = path.join(os.tmpdir(), `lcc-e2e-${process.pid}`);

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true },
  webServer: {
    command: 'node src/server.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: dataDir, CHAT_PROVIDER: 'test',
      AI_API_KEY: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', TOKEN_ENCRYPTION_KEY: '',
    },
  },
});
