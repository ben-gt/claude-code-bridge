import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, scrubUrl, addSecret } from '../src/scrub.js';

test('strips userinfo from URLs', () => {
  assert.equal(scrub('cloning https://user:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/o/r.git'), 'cloning https://<redacted>@github.com/o/r.git');
  assert.equal(scrubUrl('https://x-access-token:abc123@git.example.com/a/b.git'), 'https://git.example.com/a/b.git');
  assert.equal(scrub('MONGO_URL=mongodb+srv://bob:hunter2@cluster0.mongodb.net/db'), 'MONGO_URL=mongodb+srv://<redacted>@cluster0.mongodb.net/db');
});

test('redacts common token shapes', () => {
  assert.ok(!scrub('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').includes('ghp_ABC'));
  assert.ok(!scrub('github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').includes('11ABCDEFG'));
  assert.ok(!scrub('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789').includes('api03'));
  assert.ok(!scrub('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789').includes('abcdefghij'));
  assert.ok(!scrub('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U').includes('dozjg'));
  assert.ok(!scrub('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1\n-----END OPENSSH PRIVATE KEY-----').includes('AAAAB3'));
  assert.ok(!scrub('api_abcdefghijklmnopqrstuvwxyz').includes('abcdefghij'));
});

test('redacts env-file style lines but keeps the key name', () => {
  const out = scrub('PORT=3000\nOPENROUTER_API_KEY=or-1234567890abcdef\nexport DB_PASSWORD="s3cret"\nWEBUI_SECRET_KEY: abc\n');
  assert.match(out, /PORT=3000/);
  assert.match(out, /OPENROUTER_API_KEY=<redacted>/);
  assert.ok(!out.includes('or-1234567890'));
  assert.ok(!out.includes('s3cret'));
  assert.match(out, /WEBUI_SECRET_KEY: <redacted>/);
});

test('redacts json fields', () => {
  const out = scrub('{"api_key": "abcd1234efgh", "name": "x", "password":"p@ssw0rd"}');
  assert.ok(!out.includes('abcd1234efgh'));
  assert.ok(!out.includes('p@ssw0rd'));
  assert.match(out, /"name": "x"/);
});

test('exact secrets registered at runtime are removed everywhere', () => {
  addSecret('ccb_SUPERSECRETVALUE_123');
  assert.equal(scrub('header ccb_SUPERSECRETVALUE_123 end'), 'header <redacted> end');
});
