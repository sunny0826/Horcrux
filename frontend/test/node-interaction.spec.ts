import { test, expect } from '@playwright/test';
import fs from 'fs';

test('Target Node 自动填充 Source Node 镜像引用', async ({ page }) => {
  const rawBaseURL = process.env.HORCRUX_BASE_URL || 'http://localhost:7626';
  const baseURL = rawBaseURL.replace('localhost', '127.0.0.1');

  // Catch-all for debugging
  await page.route('**/api/**', async (route) => {
    console.log(`UNHANDLED API REQUEST: ${route.request().url()}`);
    await route.fallback();
  });

  // Mock pipes list
  await page.route('**/api/pipes?*', async (route) => {
    console.log('MOCK HIT: pipes list');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 'test-pipe',
        name: 'TEST_PIPE',
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }]),
    });
  });

  // Mock single pipe
  await page.route('**/api/pipes/test-pipe', async (route) => {
    console.log('MOCK HIT: pipes/test-pipe');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'test-pipe',
        name: 'TEST_PIPE',
        nodes: [],
        edges: [],
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
  });

  // Mock credentials
  await page.route('**/api/vault/credentials', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'cred1', name: 'TEST_CRED', registry: 'docker.io' },
      ]),
    });
  });

  // Mock repositories
  await page.route('**/api/registry/repositories*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ repositories: ['library/nginx'] }),
    });
  });

  // Mock tags
  await page.route('**/api/registry/tags*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tags: ['latest'] }),
    });
  });

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  
  page.on('console', msg => console.log(`BROWSER LOG: ${msg.text()}`));
  page.on('requestfailed', request => console.log(`REQUEST FAILED: ${request.url()} ${request.failure()?.errorText}`));

  // Switch to Flow.Designer tab
  await page.getByRole('button', { name: /Flow\.Designer/i }).click();

  await page.getByRole('button', { name: /TEST_PIPE/i }).click();

  await page.waitForTimeout(2000);
  await fs.promises.writeFile('debug_page.html', await page.content());

  // Wait for designer to load
  await expect(page.getByTitle('Add Source')).toBeVisible();

  // 1. Add Source Node
  await page.getByTitle('Add Source').click();
  const sourceNode = page.locator('.react-flow__node-sourceNode').first();
  await expect(sourceNode).toBeVisible();
  
  // 2. Configure Source Node
  await sourceNode.click();

  // Select Credential
  await page.getByTestId('node-cred-select').selectOption('cred1');
  await page.getByTestId('source-step-1-next').click();

  // Wait for repos and Click Next
  await expect(page.getByTestId('source-step-2-next')).toBeEnabled();
  await page.getByTestId('source-step-2-next').click();

  // Select Repo
  await page.getByText('library/nginx', { exact: true }).click();

  // Select Tag
  await page.getByText('latest', { exact: true }).click();

  // Save
  await page.getByRole('button', { name: 'SAVE' }).click();

  // Verify Source Node has updated image
  await expect(sourceNode).toContainText('nginx:latest');

  // 3. Add Target Node
  await page.getByTitle('Add Target').click();
  const targetNode = page.locator('.react-flow__node-targetNode').first();
  await expect(targetNode).toBeVisible();

  // 4. Verify Target Node has auto-filled image
  await expect(targetNode).toContainText('nginx:latest');
});
