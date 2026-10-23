import { test, expect } from '@playwright/test';
import { watchProblems, loadSamples, addTestAccount, openScheduler } from './helpers.js';

// External Livestream Terms modal. Test Mode streams always count as owned, so the server never asks
// for terms on its own; the FIRST start request is answered with the server's real error shape
// (409 TERMS_ACCEPTANCE_REQUIRED). Decisions are recorded by the real server. Nothing is posted.
const VID = 'termsVideo1';

async function setup(page, label) {
  // Validate is mocked to stay under the 10/min validate+select limit across specs; select is real.
  await page.route('**/api/workflows/*/stream/validate', (route) => route.fulfill({ json: {
    videoId: VID, url: `https://www.youtube.com/watch?v=${VID}`, status: 'live', title: 'Terms test stream',
    channelTitle: 'Test Mode channel', owned: true, external: false, chatAvailable: true, chatReadable: true, chatReason: null,
    postingPermission: 'owner', requiresAcknowledgement: false, canConnect: true, message: 'The stream is live and its chat is available.',
  } }));
  await loadSamples(page);
  await addTestAccount(page, label);
  await openScheduler(page, label);
  const card = page.locator('.stream-setup');
  await card.getByLabel('YouTube livestream URL').fill(`https://www.youtube.com/watch?v=${VID}`);
  await card.getByRole('button', { name: 'Validate Stream' }).click();
  await expect(card.locator('[data-stream-status]')).toHaveText('Live');
  await card.getByRole('button', { name: 'Connect to Stream' }).click();
  await expect(card.locator('.stream-saved')).toContainText(VID);

  let starts = 0;
  await page.route('**/api/workflows/*/start', async (route) => {
    starts += 1;
    if (starts === 1) {
      await route.fulfill({ status: 409, json: { error: {
        code: 'TERMS_ACCEPTANCE_REQUIRED', message: 'Read and accept the External Livestream Terms for this account and livestream before starting.',
        details: { termsVersion: 'x', videoId: VID },
      } } });
    } else {
      await route.continue();
    }
  });
  return { starts: () => starts };
}

async function openModal(page) {
  await page.locator('#view-scheduler').getByRole('button', { name: 'Start', exact: true }).click();
  const dialog = page.locator('dialog.dialog-terms[open]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('DRAFT');
  await expect(dialog).toContainText('does not protect you from');
  return dialog;
}

async function readToEnd(dialog) {
  const box = dialog.getByRole('checkbox');
  await expect(box).toBeDisabled(); // complete terms must be shown first
  await dialog.locator('.terms-scroll').evaluate((r) => { r.scrollTop = r.scrollHeight; });
  await expect(box).toBeEnabled();
  return box;
}

test('declining the terms records a decline and does not start the scheduler', async ({ page }) => {
  const problems = watchProblems(page);
  const s = await setup(page, 'Terms decline account');
  const dialog = await openModal(page);
  await expect(dialog.getByRole('button', { name: 'Accept and continue' })).toBeDisabled();
  await readToEnd(dialog);
  await dialog.getByRole('button', { name: 'Decline' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toasts')).toContainText('Terms declined');
  expect(s.starts()).toBe(1);
  await expect(page.locator('#view-scheduler').getByRole('button', { name: 'Start', exact: true })).toBeEnabled();

  await page.goto('/#terms');
  const row = page.locator('#view-terms tbody tr').filter({ hasText: VID }).first();
  await expect(row).toContainText('Declined');
  await expect(row).toContainText('Terms decline account');
  expect(problems).toEqual([]);
});

test('closing the modal without deciding records nothing', async ({ page }) => {
  await setup(page, 'Terms escape account');
  const dialog = await openModal(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.goto('/#terms');
  await expect(page.locator('#view-terms tbody tr').filter({ hasText: 'Terms escape account' })).toHaveCount(0);
});

test('accepting requires the checkbox, records an acceptance, then starts', async ({ page }) => {
  const problems = watchProblems(page);
  const s = await setup(page, 'Terms accept account');
  const dialog = await openModal(page);
  const accept = dialog.getByRole('button', { name: 'Accept and continue' });
  const box = await readToEnd(dialog);
  await expect(accept).toBeDisabled();
  await box.check();
  await accept.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toasts')).toContainText('Scheduler started');
  expect(s.starts()).toBe(2);
  await page.locator('#view-scheduler').getByRole('button', { name: 'Stop', exact: true }).click();

  await page.goto('/#terms');
  await expect(page.locator('#view-terms')).toContainText('External Livestream Terms (current version)');
  const row = page.locator('#view-terms tbody tr').filter({ hasText: 'Terms accept account' }).first();
  await expect(row).toContainText('Accepted');
  await expect(row).toContainText('Current version');
  expect(problems).toEqual([]);
});
