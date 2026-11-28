/** The pure parts of kids' photos and videos: what a file is, where it goes, which part of it is sent. No database. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  downloadName,
  isShareToken,
  kidMediaDir,
  kidMediaFile,
  looksLike,
  parseRange,
  shareToken,
  shareTokenHash,
  sweepMediaFiles,
  titleFromHeader,
} from '../src/media';

const A = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';

describe('what a file is', () => {
  it('knows photos and videos by their first bytes', () => {
    assert.equal(looksLike('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true);
    assert.equal(looksLike('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])), true);
    assert.equal(looksLike('video/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), true);
    assert.equal(looksLike('video/mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp')])), true);
    assert.equal(looksLike('image/gif', Buffer.from('GIF89a')), true);
  });

  it('says no when the bytes are something else, or too few', () => {
    const page = Buffer.from('<html>');
    for (const type of ['image/jpeg', 'image/png', 'video/webm', 'video/mp4', 'image/gif', 'image/webp', 'audio/amr']) assert.equal(looksLike(type, page), false, type);
    assert.equal(looksLike('image/jpeg', Buffer.from([0xff, 0xd8])), false);
    assert.equal(looksLike('video/mp4', Buffer.from('ftyp')), false);
    assert.equal(looksLike('image/png', Buffer.alloc(0)), false);
  });

  it('cannot tell for types without a signature', () => {
    assert.equal(looksLike('audio/mpeg', Buffer.from('anything')), null);
    assert.equal(looksLike('text/html', Buffer.from('<html>')), null);
  });
});

describe('titles from a header', () => {
  const b64 = (t: string): string => Buffer.from(t, 'utf8').toString('base64');
  it('decodes UTF-8, keeps one line, cuts at 120 characters', () => {
    assert.equal(titleFromHeader(b64('Our dog Pickles 🐶')), 'Our dog Pickles 🐶');
    assert.equal(titleFromHeader(b64('one\r\ntwo\tthree')), 'one two three');
    assert.equal([...titleFromHeader(b64('🐶'.repeat(200)))].length, 120);
    assert.equal(titleFromHeader(''), '');
    assert.equal(titleFromHeader('not base64 at all!'), '');
    assert.equal(titleFromHeader('A'.repeat(3000)), '');
  });
});

describe('where files go', () => {
  it('a folder per family and kid, a file named by its id', () => {
    assert.equal(kidMediaFile('/data', A, K, M), path.join('/data', 'kid-media', A, K, M));
  });

  it('refuses anything that is not an id, so no text can become a path', () => {
    for (const bad of ['..', '../..', '', 'a/b', `${A}/..`, `${A}\0`, '.', A.slice(0, -1)]) {
      assert.throws(() => kidMediaDir('/data', bad, K), /ids/, bad);
      assert.throws(() => kidMediaDir('/data', A, bad), /ids/, bad);
      assert.throws(() => kidMediaFile('/data', A, K, bad), /ids/, bad);
    }
  });
});

describe('share links', () => {
  it('the token comes from the secret, the item and its nonce; the stored hash does not give it away', () => {
    const t = shareToken('secret', M, 'nonce-1');
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(isShareToken(t), true);
    assert.equal(shareToken('secret', M, 'nonce-1'), t);
    assert.notEqual(shareToken('secret', M, 'nonce-2'), t);
    assert.notEqual(shareToken('other secret', M, 'nonce-1'), t);
    assert.notEqual(shareToken('secret', A, 'nonce-1'), t);
    assert.match(shareTokenHash(t), /^[0-9a-f]{64}$/);
    assert.equal(shareTokenHash(t).includes(t), false);
  });

  it('only token-shaped text is looked up', () => {
    for (const bad of ['', 'short', '../../etc/passwd', 'a'.repeat(31), 'a'.repeat(65), `${'a'.repeat(40)}/..`, `${'a'.repeat(40)}%2f`, M, 'a'.repeat(44)]) assert.equal(isShareToken(bad), false, bad);
  });
});

describe('Range', () => {
  it('reads one range', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: 999 });
    assert.deepEqual(parseRange('bytes=-500', 1000), { start: 500, end: 999 });
    assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
    assert.deepEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  });

  it('a range past the end cannot be sent', () => {
    assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=5-2', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
  });

  it('anything else means the whole file', () => {
    for (const h of [undefined, '', 'bytes=-', 'bytes=0-1,5-6', 'items=0-5', 'bytes=a-b', 'bytes=1.5-2']) assert.equal(parseRange(h, 1000), null, String(h));
  });
});

describe('download names', () => {
  it('are plain file names', () => {
    assert.equal(downloadName('Lego heist', 'movie', 'video/webm'), 'Lego heist.webm');
    assert.equal(downloadName('../../etc/passwd"\r\nX: y', 'photo', 'image/jpeg'), '.. .. etc passwd X y.jpg');
    assert.equal(downloadName('🐶🐶', 'photo', 'image/png'), 'photo.png');
    assert.equal(downloadName('', 'video', 'video/mp4'), 'video.mp4');
  });
});

describe('the sweep', () => {
  it('removes folders of kids that are gone, files without a row and old half uploads; keeps what is owned or fresh', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-sweep-'));
    try {
      const goneKid = '44444444-4444-4444-8444-444444444444';
      const goneAccount = '55555555-5555-4555-8555-555555555555';
      const stray = '66666666-6666-4666-8666-666666666666';
      const textKept = '77777777-7777-4777-8777-777777777777';
      const textStray = '88888888-8888-4888-8888-888888888888';
      const write = (file: string): void => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'x');
      };
      write(kidMediaFile(dir, A, K, M));
      write(kidMediaFile(dir, A, K, stray));
      write(`${kidMediaFile(dir, A, K, stray)}.abc.part`);
      write(kidMediaFile(dir, A, goneKid, M));
      write(kidMediaFile(dir, goneAccount, K, M));
      write(path.join(dir, 'text-media', textKept));
      write(path.join(dir, 'text-media', textStray));
      const known = {
        kids: async (): Promise<Set<string>> => new Set([`${A}/${K}`]),
        media: async (): Promise<Set<string>> => new Set([M]),
        textMedia: async (): Promise<Set<string>> => new Set([textKept]),
      };
      // Everything is fresh: nothing goes.
      assert.equal(await sweepMediaFiles(dir, known), 0);
      assert.equal(fs.existsSync(kidMediaFile(dir, A, goneKid, M)), true);
      // Two hours on.
      await sweepMediaFiles(dir, known, Date.now() + 2 * 3600_000);
      assert.deepEqual(fs.readdirSync(kidMediaDir(dir, A, K)), [M]);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'kid-media', A)), [K]);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'kid-media')), [A]);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'text-media')), [textKept]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
