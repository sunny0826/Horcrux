import { defineConfig, devices } from '@playwright/test';

const defaultBaseURL = 'http://127.0.0.1:7626';
const baseURL = (process.env.HORCRUX_BASE_URL || defaultBaseURL).replace('localhost', '127.0.0.1');
process.env.HORCRUX_BASE_URL = baseURL;

export default defineConfig({
  testDir: './test',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: 'make dev',
    url: defaultBaseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
