import { test, expect } from '@playwright/test';
import { watchProblems, loadSamples, addTestAccount, openScheduler, workflowRow } from './helpers.js';

// Two accounts, two independent workflows, each bound to its own stream (Test Mode: every stream
// counts as owned by the account, so both may run at once). Nothing reaches YouTube.
//
// Validation responses are mocked (the validate UI is covered in stream.spec.js) to stay under
// the server's 10/min limit on validate/select; the selections themselves are real.
test('independent workflows per account; a stream in use by another account is refused', async ({ page }) => {
  test.setTimeout(90_000);
  const problems = watchProblems(page);
  await page.route('**/api/workflows/*/stream/validate', async (route) => {
    const { url } = route.request().postDataJSON();
    const videoId = /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})|\/live\/([\w-]{11})/.exec(url)?.slice(1).find(Boolean);
    await route.fulfill({ json: {
      videoId, url: `https://www.youtube.com/watch?v=${videoId}`, status: 'live', title: `Stream ${videoId}`,
      channelTitle: 'Test Mode channel', owned: true, external: false, chatAvailable: true, chatReadable: true, chatReason: null,
      postingPermission: 'owner', requiresAcknowledgement: false, canConnect: true, message: 'The stream is live and its chat is available.',
    } });
  });

  await loadSamples(page);
  await addTestAccount(page, 'WF account A');
  await addTestAccount(page, 'WF account B');

  const setup = page.locator('.stream-setup');
  const select = async (label, videoId) => {
    await openScheduler(page, label);
    await setup.getByLabel('YouTube livestream URL').fill(`https://www.youtube.com/watch?v=${videoId}`);
    await setup.getByRole('button', { name: 'Validate Stream' }).click();
    await expect(setup.locator('[data-stream-status]')).toHaveText('Live');
    await setup.getByRole('button', { name: 'Connect to Stream' }).click();
  };

  // Each account selects its own stream; switching accounts shows that account's selection only.
  await select('WF account A', 'wfVideoAAA1');
  await expect(setup.locator('.stream-saved')).toContainText('wfVideoAAA1');
  await select('WF account B', 'wfVideoBBB2');
  await expect(setup.locator('.stream-saved')).toContainText('wfVideoBBB2');
  await openScheduler(page, 'WF account A');
  await expect(setup.locator('.stream-saved')).toContainText('wfVideoAAA1');
  await expect(setup.locator('.stream-saved')).not.toContainText('wfVideoBBB2');

  // Overview: start both, then stop B; A keeps running.
  await page.goto('/#overview');
  const rowA = workflowRow(page, 'WF account A');
  const rowB = workflowRow(page, 'WF account B');
  await rowA.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(rowA).toContainText(/running/i);
  await rowB.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(rowB).toContainText(/running/i);
  await expect(page.locator('.workflows-summary')).toContainText('2 running');
  await expect(page.locator('#nav-status-pill')).toContainText('2 running');

  await rowB.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(rowB).toContainText(/idle/i);
  await expect(rowA).toContainText(/running/i);
  await expect(page.locator('.workflows-summary')).toContainText('1 running');

  // B selects A's (running) stream: the server refuses it (at select or at start) with STREAM_IN_USE.
  await select('WF account B', 'wfVideoAAA1');
  const view = page.locator('#view-scheduler');
  const refusedAtSelect = await setup.locator('.error-box').filter({ hasText: 'STREAM_IN_USE' })
    .waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (!refusedAtSelect) {
    await expect(setup.locator('.stream-saved')).toContainText('wfVideoAAA1');
    await view.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(view.locator('.control-errors')).toContainText('STREAM_IN_USE');
  }
  await page.goto('/#overview');
  await expect(rowB).toContainText(/idle/i);
  await expect(rowA).toContainText(/running/i);

  // Clean up: stop A.
  await rowA.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(rowA).toContainText(/idle/i);

  expect(problems).toEqual([]);
});
