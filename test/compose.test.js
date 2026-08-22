import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findComposeFiles, resolveComposeTarget, parsePs, isProtected, COMPOSE_FILE_RE } from '../src/compose.js';
import { BoundaryError } from '../src/paths.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-compose-'));
const mk = (name, files) => { const d = path.join(root, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); for (const f of files) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'services: {}\n'); } return d; };
mk('single', ['docker-compose.yml']);
mk('withoverride', ['docker-compose.yml', 'docker-compose.override.yml']);
mk('multi', ['docker-compose.yml', 'docker-compose.prod.yml', 'deploy/compose.yaml']);
mk('none', ['README.md']);
mk('openui', ['docker-compose.yml']);
const cfg = { workspace_root: root, compose: { protected: ['openui'] } };

test('detects every compose file, canonical first', () => {
  const f = findComposeFiles(path.join(root, 'multi')).map(x => x.file);
  assert.deepEqual(f, ['docker-compose.yml', 'deploy/compose.yaml', 'docker-compose.prod.yml']);
  assert.ok(COMPOSE_FILE_RE.test('docker-compose-dev.yml') && COMPOSE_FILE_RE.test('compose.yaml') && !COMPOSE_FILE_RE.test('compose.json'));
});

test('defaults only when unambiguous; refuses and lists options otherwise', () => {
  assert.deepEqual(resolveComposeTarget(cfg, 'single').files, ['docker-compose.yml']);
  assert.deepEqual(resolveComposeTarget(cfg, 'withoverride').files, ['docker-compose.yml', 'docker-compose.override.yml']);
  assert.throws(() => resolveComposeTarget(cfg, 'multi'), /3 Compose files; pass file= to choose one of: docker-compose.yml, deploy\/compose.yaml, docker-compose.prod.yml/);
  assert.deepEqual(resolveComposeTarget(cfg, 'multi', { file: 'deploy/compose.yaml' }).files, ['deploy/compose.yaml']);
  assert.throws(() => resolveComposeTarget(cfg, 'multi', { file: '../single/docker-compose.yml' }), BoundaryError);
  assert.throws(() => resolveComposeTarget(cfg, 'multi', { file: '/etc/passwd' }), BoundaryError);
  assert.throws(() => resolveComposeTarget(cfg, 'none'), /no Compose file/);
});

test('protected list by dir name or compose project name', () => {
  assert.match(resolveComposeTarget(cfg, 'openui').protectedBy, /protected list/);
  assert.equal(resolveComposeTarget(cfg, 'single').protectedBy, null);
  assert.match(isProtected(cfg, 'single', 'openui'), /compose project "openui"/);
});

test('parsePs handles array and ndjson', () => {
  const arr = '[{"Service":"db","Name":"x-db-1","State":"running","Health":"healthy","Status":"Up 2 days","Publishers":[{"URL":"0.0.0.0","PublishedPort":5432,"TargetPort":5432,"Protocol":"tcp"}]}]';
  assert.equal(parsePs(arr)[0].ports[0], '0.0.0.0:5432->5432/tcp');
  const nd = '{"Service":"b","State":"exited"}\n{"Service":"a","State":"running"}\n';
  assert.deepEqual(parsePs(nd).map(x => x.service), ['a', 'b']);
});

test('no destructive verbs exist in the compose module', () => {
  const src = fs.readFileSync(new URL('../src/compose.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/jobs.js', import.meta.url), 'utf8');
  assert.ok(!/['"]down['"]/.test(src), 'compose down must not be implemented');
  assert.ok(!/['"]-v['"]|--volumes|['"]prune['"]|['"]rm['"]/.test(src), 'volume removal / prune must not be implemented');
});
