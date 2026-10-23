import { test, expect } from '@playwright/test';
import { watchProblems, loadSamples, addTestAccount, openScheduler } from './helpers.js';

// Livestream Setup in Test Mode. The test provider treats any well-formed video id as a
// simulated live stream it owns; nothing is posted anywhere.
test('livestream setup: validate, connect, lock while running, clear', async ({ page }) => {
  const problems = watchProblems(page);

  await loadSamples(page);
  await addTestAccount(page, 'E2E stream channel');
  await openScheduler(page, 'E2E stream channel');

  const card = page.locator('.stream-setup');
  const status = card.locator('[data-stream-status]');
  const input = card.getByLabel('YouTube livestream URL');
  await expect(card.getByRole('heading', { name: 'Livestream Setup' })).toBeVisible();
  await expect(card.locator('.stream-saved')).toContainText('No livestream selected'); // new account: nothing selected
  await expect(status).toHaveText('Not checked');

  // Unrelated URL -> Error, Connect stays disabled.
  await input.fill('https://example.com/watch?v=dQw4w9WgXcQ');
  await card.getByRole('button', { name: 'Validate Stream' }).click();
  await expect(status).toHaveText('Error');
  await expect(card.locator('.error-box strong')).toHaveText('Not a YouTube livestream link');
  await expect(card.getByRole('button', { name: 'Connect to Stream' })).toBeDisabled();

  // Valid youtu.be URL -> Live -> Connect.
  await input.fill('https://youtu.be/dQw4w9WgXcQ');
  await expect(status).toHaveText('Not checked');
  await card.getByRole('button', { name: 'Validate Stream' }).click();
  await expect(status).toHaveText('Live');
  // Test Mode streams count as owned: no external-permission checkbox, posting allowed.
  await expect(card).toContainText('Your channel');
  await expect(card).toContainText('Allowed (you own this stream)');
  await expect(card.locator('.stream-ack')).toBeHidden();
  await card.getByRole('button', { name: 'Connect to Stream' }).click();
  await expect(card.locator('.stream-saved')).toContainText('dQw4w9WgXcQ');

  // Start this account's workflow: controls lock and the selected stream is shown prominently.
  const view = page.locator('#view-scheduler');
  await view.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.stream-banner-active')).toContainText('Streaming to:');
  await expect(input).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Validate Stream' })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Clear selection' })).toBeDisabled();
  await expect(card).toContainText('Stop the scheduler to change streams.');

  // Stop: unlocked again; clear the selection.
  await view.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(input).toBeEnabled();
  await card.getByRole('button', { name: 'Clear selection' }).click();
  await expect(card.locator('.stream-saved')).toContainText('No livestream selected');

  expect(problems).toEqual([]);
});

test('stream selection API rejects foreign origins', async ({ request }) => {
  const res = await request.post('/api/workflows/any-id/stream/select', { headers: { Origin: 'https://evil.example' }, data: { url: 'https://youtu.be/dQw4w9WgXcQ' } });
  expect(res.status()).toBe(403);
});

// External-channel stream. Test Mode streams always count as owned, so the server's validate/select
// responses (and the selection in the workflow poll) are mocked here to exercise the
// acknowledgement UI. Nothing is persisted or posted.
test('external stream: posting shown as unverified, Connect needs the permission checkbox', async ({ page }) => {
  const VID = 'extVideo001';
  const validation = {
    videoId: VID, url: `https://www.youtube.com/watch?v=${VID}`, status: 'live', title: 'Someone else stream',
    channelTitle: 'Other Channel', owned: false, external: true, chatAvailable: true, chatReadable: true, chatReason: null,
    postingPermission: 'unverified', requiresAcknowledgement: true, canConnect: true,
    message: 'Posting permission cannot be verified in advance; it is confirmed only when YouTube accepts the first message.',
  };
  let selection = null;
  let selectBody = null;
  await page.route('**/api/workflows/*/stream/validate', (route) => route.fulfill({ json: validation }));
  await page.route('**/api/workflows/*/stream/select', (route) => {
    selectBody = route.request().postDataJSON();
    const now = new Date().toISOString();
    selection = { videoId: VID, url: validation.url, title: validation.title, channelTitle: validation.channelTitle, validatedAt: now, external: true, acknowledgedAt: now };
    route.fulfill({ json: { selection, validation } });
  });
  // Keep the mocked selection in the 2 s workflow poll so it isn't replaced by the real (empty) one.
  await page.route('**/api/workflows', async (route) => {
    // A poll can still be in flight when the test ends and the page closes; ignore that teardown race.
    try {
      const res = await route.fetch();
      const data = await res.json();
      if (selection) for (const w of data.items || []) if (w.label === 'E2E stream channel') { w.selection = selection; if (w.status) w.status.stream = selection; }
      await route.fulfill({ response: res, json: data });
    } catch {
      await route.abort().catch(() => {});
    }
  });

  await openScheduler(page, 'E2E stream channel');
  const card = page.locator('.stream-setup');
  await card.getByLabel('YouTube livestream URL').fill(`https://youtu.be/${VID}`);
  await card.getByRole('button', { name: 'Validate Stream' }).click();
  await expect(card.locator('[data-stream-status]')).toHaveText('Live');
  await expect(card).toContainText('External channel');
  await expect(card).toContainText('Not verifiable in advance');

  const connect = card.getByRole('button', { name: 'Connect to Stream' });
  await expect(card.locator('.stream-ack')).toBeVisible();
  await expect(connect).toBeDisabled();
  await card.locator('.stream-ack input[type="checkbox"]').check();
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect.poll(() => selectBody).not.toBeNull();
  expect(selectBody).toEqual({ url: `https://youtu.be/${VID}`, acknowledgeExternal: true });
  await expect(card.locator('.stream-saved')).toContainText('Permission confirmed');
});
