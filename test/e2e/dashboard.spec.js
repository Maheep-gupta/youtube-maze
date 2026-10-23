import { test, expect } from '@playwright/test';
import { watchProblems, addTestAccount, openScheduler, workflowRow } from './helpers.js';

test('dashboard end-to-end in test mode', async ({ page }) => {
  const problems = watchProblems(page);

  await page.goto('/#overview');
  await expect(page.locator('#test-banner')).toBeVisible();

  // Message Studio: load the sample library.
  await page.goto('/#studio');
  await page.getByRole('button', { name: 'Load sample library' }).click();
  await expect(page.locator('dialog[open]')).toContainText('imported 40');
  await page.keyboard.press('Escape');

  // Accounts: Google OAuth is not configured in e2e; add a test account (nothing is posted).
  await page.goto('/#connections');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add YouTube Account' })).toBeDisabled();
  await addTestAccount(page, 'E2E channel');

  // Livestream Setup for this account (Test Mode simulates the stream as live).
  await openScheduler(page, 'E2E channel');
  const setup = page.locator('.stream-setup');
  await setup.getByLabel('YouTube livestream URL').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await setup.getByRole('button', { name: 'Validate Stream' }).click();
  await expect(setup.locator('[data-stream-status]')).toHaveText('Live');
  await setup.getByRole('button', { name: 'Connect to Stream' }).click();
  await expect(setup.locator('.stream-saved')).toContainText('dQw4w9WgXcQ');

  // Overview: start this account's workflow, wait for a provider-confirmed send, then stop.
  await page.goto('/#overview');
  const row = workflowRow(page, 'E2E channel');
  await expect(row).toContainText('dQw4w9WgXcQ');
  await row.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(row).toContainText(/running/i);
  const sent = await page.waitForResponse(async (r) => {
    if (!r.url().endsWith('/api/workflows')) return false;
    const data = await r.json();
    const w = (data.items || []).find((x) => x.label === 'E2E channel');
    return w?.status?.session?.messagesSent >= 1;
  }, { timeout: 25_000 });
  const w = (await sent.json()).items.find((x) => x.label === 'E2E channel');
  expect(w.status.isTestMode).toBe(true);
  await row.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(row).toContainText(/idle|stopped/i);

  // Activity log shows the confirmed send, filterable by account.
  await page.goto('/#logs');
  await expect(page.locator('#view-logs')).toContainText('message.sent');
  await page.locator('#view-logs select[name="logAccount"]').selectOption({ label: 'E2E channel' });
  await expect(page.locator('#view-logs tbody')).toContainText('E2E channel');

  expect(problems).toEqual([]);
});

test('state-changing API calls from a foreign origin are rejected', async ({ request }) => {
  const res = await request.post('/api/workflows/any-id/stop', { headers: { Origin: 'https://evil.example' }, data: {} });
  expect(res.status()).toBe(403);
});
