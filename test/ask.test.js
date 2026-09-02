import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Asker } from '../src/ask.js';

const quiet = { info() {}, warn() {} };
const mk = (notify = {}) => new Asker(
  { notify: { webhook_url: 'http://localhost:8090/api/v1/channels/webhooks/w/t',
              chat_base_url: 'https://robut.bnd1.app', api_key: 'k', channel_id: 'c' } },
  { enabled: true, post() {}, ...notify },
  { log: quiet },
);

test('reads from the local origin, links to the public one', () => {
  const a = mk();
  // The public origin sits behind Cloudflare Access and answers an API GET
  // with an HTML login page, which silently broke the first live test.
  assert.equal(a.base, 'http://localhost:8090');
  assert.equal(a.linkBase, 'https://robut.bnd1.app');
  assert.equal(a.enabled, true);
});

test('stays disabled unless fully configured', () => {
  for (const notify of [{ chat_base_url: 'x' }, { api_key: 'k' }, { channel_id: 'c' }]) {
    assert.equal(new Asker({ notify }, { enabled: true, post() {} }, { log: quiet }).enabled, false);
  }
  // A working config but a disabled notifier is still unusable.
  assert.equal(new Asker(
    { notify: { webhook_url: 'http://h/x', chat_base_url: 'h', api_key: 'k', channel_id: 'c' } },
    { enabled: false, post() {} }, { log: quiet },
  ).enabled, false);
});

test('an unconfigured asker reports unavailable rather than pretending', async () => {
  const a = new Asker({ notify: {} }, { enabled: false, post() {} }, { log: quiet });
  assert.deepEqual(await a.ask({ question: 'q' }), { status: 'unavailable' });
});

test('matching handles numbers, exact text, terse replies and refuses ambiguity', () => {
  const o = ['Merge it', 'Leave it', 'Ask me later'];
  assert.equal(Asker.choose('2', o), 'Leave it');
  assert.equal(Asker.choose('Merge it', o), 'Merge it');
  assert.equal(Asker.choose('merge', o), 'Merge it', 'terse replies are the common case');
  assert.equal(Asker.choose('LEAVE IT please', o), 'Leave it');
  assert.equal(Asker.choose('later', o), 'Ask me later');
  assert.equal(Asker.choose('merge it or leave it', o), null, 'ambiguous is not an answer');
  assert.equal(Asker.choose('9', o), null, 'out of range');
  assert.equal(Asker.choose('', o), null);
  assert.equal(Asker.choose('anything', []), null, 'free-text questions have no choice');
});
