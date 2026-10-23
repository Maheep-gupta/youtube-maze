import { test, expect } from '@playwright/test';
import { watchProblems, loadSamples, addTestAccount, openScheduler } from './helpers.js';

// Manual review mode in Test Mode: each picked message waits for approval; nothing reaches YouTube.
test('manual review: approve sends, skip discards', async ({ page }) => {
  test.setTimeout(120_000); // the second proposal arrives one interval (30 s) after the first
  const problems = watchProblems(page);

  await loadSamples(page);
  await addTestAccount(page, 'E2E review channel');
  await openScheduler(page, 'E2E review channel');

  const view = page.locator('#view-scheduler');
  const setup = page.locator('.stream-setup');
  await setup.getByLabel('YouTube livestream URL').fill('https://www.youtube.com/live/dQw4w9WgXcQ');
  await setup.getByRole('button', { name: 'Validate Stream' }).click();
  await expect(setup.locator('[data-stream-status]')).toHaveText('Live');
  await setup.getByRole('button', { name: 'Connect to Stream' }).click();
  await expect(setup.locator('.stream-saved')).toContainText('dQw4w9WgXcQ');

  // Enable manual review with the shortest interval (settings belong to this account only).
  await view.locator('input[name="intervalSeconds"]').fill('30');
  await view.locator('input[name="minDelaySeconds"]').fill('10');
  await view.getByLabel('Manual review').check();
  await view.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#toasts')).toContainText('settings saved');

  await view.getByRole('button', { name: 'Start', exact: true }).click();

  // First tick (≤ 10 s) proposes a message instead of posting it.
  const panel = page.locator('.review-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel).toContainText('Message awaiting your approval');
  await panel.getByRole('button', { name: 'Approve & send' }).click();
  await expect(page.locator('#toasts')).toContainText('Message sent');
  await expect(panel).toBeHidden();

  // Next proposal: skip it; nothing is sent.
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await panel.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('#toasts')).toContainText('Message skipped');
  await expect(panel).toBeHidden();

  await view.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(view.locator('.stream-setup input[type="url"]')).toBeEnabled();

  expect(problems).toEqual([]);
});
