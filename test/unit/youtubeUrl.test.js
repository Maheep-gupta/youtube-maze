import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeStreamUrl, isValidVideoId } from '../../src/lib/youtubeUrl.js';

const ID = 'dQw4w9WgXcQ';
const CANON = `https://www.youtube.com/watch?v=${ID}`;

describe('parseYouTubeStreamUrl: supported formats', () => {
  const ok = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=42s&feature=share`,
    `https://www.youtube.com/watch?feature=share&v=${ID}`,
    `https://WWW.YouTube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc123`,
    `https://youtu.be/${ID}/`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=shared`,
    `https://www.youtube.com/live/${ID}/`,
    `  https://youtu.be/${ID}  `,
  ];
  for (const url of ok) {
    test(`accepts ${url.trim()}`, () => {
      assert.deepEqual(parseYouTubeStreamUrl(url), { videoId: ID, url: CANON });
    });
  }
  test('ids may contain - and _', () => {
    assert.equal(parseYouTubeStreamUrl('https://www.youtube.com/watch?v=a_b-C9_d-E0').videoId, 'a_b-C9_d-E0');
  });
});

describe('parseYouTubeStreamUrl: rejected input', () => {
  const bad = [
    ['not a string', 42],
    ['null', null],
    ['empty', '   '],
    ['bare id (not a URL)', ID],
    ['javascript scheme', `javascript:alert(1)//youtu.be/${ID}`],
    ['ftp scheme', `ftp://youtube.com/watch?v=${ID}`],
    ['data scheme', 'data:text/html,hi'],
    ['unrelated host', `https://vimeo.com/watch?v=${ID}`],
    ['look-alike suffix', `https://youtube.com.evil.example/watch?v=${ID}`],
    ['look-alike prefix', `https://evilyoutube.com/watch?v=${ID}`],
    ['sub-domain', `https://music.youtube.com/watch?v=${ID}`],
    ['youtu.be look-alike', `https://youtu.be.evil.example/${ID}`],
    ['credentials', `https://user:pass@www.youtube.com/watch?v=${ID}`],
    ['port', `https://www.youtube.com:8443/watch?v=${ID}`],
    ['missing v', 'https://www.youtube.com/watch'],
    ['empty v', 'https://www.youtube.com/watch?v='],
    ['duplicate v', `https://www.youtube.com/watch?v=${ID}&v=aaaaaaaaaaa`],
    ['short id', 'https://www.youtube.com/watch?v=abc'],
    ['long id', `https://www.youtube.com/watch?v=${ID}X`],
    ['encoded bad char', 'https://www.youtube.com/watch?v=dQw4w9WgX%3C'],
    ['bad char youtu.be', 'https://youtu.be/dQw4w9Wg$cQ'],
    ['youtu.be no id', 'https://youtu.be/'],
    ['youtu.be extra path', `https://youtu.be/${ID}/extra`],
    ['live no id', 'https://www.youtube.com/live/'],
    ['shorts', `https://www.youtube.com/shorts/${ID}`],
    ['channel', 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'],
    ['handle live page', 'https://www.youtube.com/@someone/live'],
    ['playlist', 'https://www.youtube.com/playlist?list=PL123'],
    ['embed', `https://www.youtube.com/embed/${ID}`],
    ['too long', `https://www.youtube.com/watch?v=${ID}&x=${'a'.repeat(2100)}`],
  ];
  for (const [label, input] of bad) {
    test(`rejects ${label}`, () => {
      assert.throws(() => parseYouTubeStreamUrl(input), (err) => {
        assert.equal(err.code, 'INVALID_STREAM_URL');
        assert.equal(err.status, 400);
        assert.ok(err.message.length > 0);
        return true;
      });
    });
  }

  test('isValidVideoId', () => {
    assert.equal(isValidVideoId(ID), true);
    assert.equal(isValidVideoId('short'), false);
    assert.equal(isValidVideoId(undefined), false);
  });
});
