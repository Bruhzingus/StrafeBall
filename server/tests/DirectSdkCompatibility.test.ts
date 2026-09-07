import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
it('pins and guards SDK Room/Connection internals used by DirectRoom.connect', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  expect(pkg.dependencies['@colyseus/sdk']).toBe('0.17.43');
  const hashes = { Room: '76b862dda219b1b5d5566d95547b4ea7bda95cd435b1cd72ee102f8dd93432d4',
    Connection: 'a27f8279522128ed7a8c5f1a5c9983c3ea5c1c4ec82c11a632e726153f228090' };
  for (const [file, hash] of Object.entries(hashes)) {
    const source = readFileSync(new URL(`../../node_modules/@colyseus/sdk/build/${file}.mjs`, import.meta.url));
    expect(createHash('sha256').update(source).digest('hex'), `SDK ${file} changed: audit DirectRoom.connect and run the Chromium direct integration before updating this guard`).toBe(hash);
  }
});
