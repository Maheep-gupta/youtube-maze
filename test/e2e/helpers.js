import { expect } from '@playwright/test';

// Shared e2e steps. Everything runs against the Test Mode provider: nothing reaches YouTube.

/** Collect page errors and CSP violations; assert `problems` is empty at the end of a test. */
export function watchProblems(page) {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(`csp: ${m.text()}`); });
  return problems;
}

/** Load the sample library (idempotent: duplicates are skipped). */
export async function loadSamples(page) {
  await page.goto('/#studio');
  await page.getByRole('button', { name: 'Load sample library' }).click();
  await expect(page.locator('dialog[open]')).toBeVisible();
  await page.keyboard.press('Escape');
}

/** Add a Test Mode account on the Accounts page. */
export async function addTestAccount(page, label) {
  await page.goto('/#connections');
  await page.getByRole('button', { name: 'Add test connection' }).click();
  await page.locator('dialog[open] input').fill(label);
  await page.locator('dialog[open]').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('#view-connections')).toContainText(label);
}

/** Open the Scheduler scoped to the account with this label. */
export async function openScheduler(page, label) {
  await page.goto('/#scheduler');
  const account = page.locator('#view-scheduler').getByRole('combobox', { name: 'Account', exact: true });
  await expect(account.locator('option', { hasText: label }).first()).toBeAttached();
  await account.selectOption({ label });
  await expect(account.locator('option:checked')).toHaveText(label);
}

/** The Overview row of one account's workflow. */
export const workflowRow = (page, label) => page.locator('.workflow-row').filter({ has: page.locator('strong', { hasText: label }) });
