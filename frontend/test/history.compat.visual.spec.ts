import { test, expect } from '@playwright/test';

test('Sync.History 兼容展示新旧任务格式', async ({ page }) => {
  const rawBaseURL = process.env.HORCRUX_BASE_URL || 'http://localhost:7626';
  const baseURL = rawBaseURL.replace('localhost', '127.0.0.1');
  const now = '2025-12-22T10:11:12.123Z';
  const taskId = 'task_visual_compat_1';

  await page.route('**/api/stats', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        active_threads: 0,
        data_throughput: '0 GB',
        manifest_assets: 1,
        auth_keys: 0,
      }),
    });
  });

  await page.route('**/api/vault/credentials', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  await page.route('**/api/pipes?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  await page.route('**/api/tasks', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tasks: [
          {
            id: taskId,
            source_ref: 'src:latest',
            target_ref: 'dst:latest',
            status: 'success',
            created_at: now,
            ended_at: now,
          },
        ],
        errors: ['legacy-task.json: missing created_at, set to now'],
      }),
    });
  });

  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task: {
          id: taskId,
          source_ref: 'src:latest',
          target_ref: 'dst:latest',
          status: 'success',
          created_at: now,
          ended_at: now,
          logs: ['line1', 'line2'],
        },
        warnings: ['some legacy fields were auto-converted'],
      }),
    });
  });

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: /Sync\.History/i }).click();
  await expect(page.getByText('Sync_Execution_Logs')).toBeVisible();
  await expect(page.getByText(taskId)).toBeVisible();
  await expect(page.getByText('legacy-task.json: missing created_at, set to now')).toBeVisible();

  await page.getByText(taskId).click();
  await expect(page.getByText(`Task_Details: ${taskId}`)).toBeVisible();
  await expect(page.getByText('some legacy fields were auto-converted').first()).toBeVisible();
  await expect(page.getByText('line2')).toBeVisible();
});
