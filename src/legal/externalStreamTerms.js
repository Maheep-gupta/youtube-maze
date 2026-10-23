import crypto from 'node:crypto';

/**
 * External Livestream Terms and Responsibility Confirmation.
 *
 * DRAFT: this text has not been reviewed by a qualified lawyer. It must be reviewed before the
 * application or these terms are distributed publicly.
 *
 * Versioning:
 *   - `version` changes on every edit (shown to the user, stored with each acknowledgement).
 *   - `materialVersion` changes only when the terms change MATERIALLY (what the user confirms, what
 *     is recorded, or what the app does). Acknowledgements are valid only for the current
 *     materialVersion, so bumping it requires everyone to acknowledge again. A typo fix bumps
 *     `version` only.
 *   - `contentHash` (SHA-256 of the text) is stored too, so a record shows exactly which text was shown.
 */
const TERMS = {
  id: 'external-stream',
  version: '1.0-draft',
  materialVersion: 1,
  effectiveDate: '2026-10-21',
  draft: true,
  title: 'External Livestream Terms and Responsibility Confirmation',
  draftNotice: 'DRAFT — not legal advice. This text has not been reviewed by a qualified lawyer and must receive qualified legal review before any public distribution.',
  sections: [
    {
      heading: '1. What this confirmation is',
      paragraphs: [
        'You are about to start automated, scheduled posting into the live chat of a livestream that is not owned by the connected YouTube channel ("external livestream").',
        'This confirmation records, on this computer only, that you read these terms and accepted them for one connected account and one livestream. It is not permission from the stream owner, not authorization from YouTube, and not a check that posting is allowed. The application still performs its normal authorization and permission checks, and YouTube decides whether each message is accepted.',
      ],
    },
    {
      heading: '2. What you confirm',
      paragraphs: [
        'By accepting, you confirm that, to the best of your knowledge:',
        '(a) the owner of this livestream, or a moderator authorized by the owner, has permitted you to post automated or scheduled messages in its chat;',
        '(b) you will follow YouTube\'s Terms of Service and Community Guidelines (including the policies on spam, deceptive practices and fake engagement) and the channel\'s own chat rules;',
        '(c) your messages will not mislead, harass or impersonate anyone, and you will be transparent that messages are scheduled where that is required or appropriate;',
        '(d) you will stop the scheduler if the stream owner or a moderator asks you to, or if YouTube restricts the account.',
      ],
    },
    {
      heading: '3. What the application can and cannot do',
      paragraphs: [
        'The application uses only the official YouTube Data API with the account you authorized. It cannot verify that the stream owner gave permission, and it cannot know in advance whether this chat accepts messages from your account (for example members-only or subscribers-only chats, bans, timeouts or slow mode). Posting is confirmed only when YouTube accepts a message.',
        'YouTube or the channel may reject, hold for review, hide or remove messages, and may time out, ban, restrict or suspend the account. The application will stop the session on permission and similar errors, but it cannot prevent these outcomes.',
      ],
    },
    {
      heading: '4. No guarantee and no protection from liability',
      paragraphs: [
        'Accepting these terms does not protect you from account restrictions, platform enforcement, complaints, lawsuits, regulatory action or any other consequence of how you use the application. These terms do not limit any rights of the stream owner, YouTube or any third party.',
        'You remain responsible for your use of the application. To the extent permitted by applicable law, the application is provided "as is", without warranties of any kind. Nothing in these terms excludes rights or liability that cannot be excluded by law.',
      ],
    },
    {
      heading: '5. What is recorded',
      paragraphs: [
        'Each time you accept or decline, the application stores locally in its SQLite database: the terms version and text fingerprint, the time (UTC), the connected account\'s local id and YouTube channel id, the livestream\'s video id, and whether you accepted or declined.',
        'No passwords, OAuth tokens, email addresses or message contents are stored in this record, and it is not sent anywhere. "Delete all local data" removes it.',
      ],
    },
    {
      heading: '6. Changes to these terms',
      paragraphs: [
        'If these terms change materially, you must read and accept the new version before starting the scheduler for an external livestream again. Your previous acknowledgements remain visible in the history.',
      ],
    },
  ],
  acceptLabel: 'I have read these terms. I confirm the statements in section 2 for this account and livestream, and I understand that this confirmation is not permission from YouTube or the stream owner.',
};

const text = [TERMS.title, TERMS.version, TERMS.draftNotice, ...TERMS.sections.flatMap((s) => [s.heading, ...s.paragraphs]), TERMS.acceptLabel].join('\n');

export const EXTERNAL_STREAM_TERMS = Object.freeze({
  ...TERMS,
  sections: Object.freeze(TERMS.sections.map((s) => Object.freeze({ ...s, paragraphs: Object.freeze([...s.paragraphs]) }))),
  contentHash: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
});
