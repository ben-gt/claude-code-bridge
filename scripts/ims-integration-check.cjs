// This trusted image entrypoint prepares only the disposable validation workspace.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const config = require('/opt/bridge-check.json');
const root = path.join('/workspace', config.app_dir);
process.chdir(root);
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for (const name of ['package.json', 'package-lock.json']) {
  if (hash(name) !== hash('/opt/bridge-inputs/' + name)) {
    console.error('VALIDATION_SETUP: dependency manifests changed; rebuild this project’s pinned validation image');
    process.exit(78);
  }
}
const modules = path.join(root, 'node_modules');
fs.mkdirSync(modules, { recursive: true });
// Writable top-level cache directories; immutable dependency package contents.
for (const entry of fs.readdirSync('/opt/bridge-deps/node_modules')) {
  if (['.cache', '.vite', '.vite-temp'].includes(entry)) continue;
  const source = path.join('/opt/bridge-deps/node_modules', entry);
  const destination = path.join(modules, entry);
  if (['.prisma', '@prisma'].includes(entry)) fs.cpSync(source, destination, { recursive: true });
  else fs.symlinkSync(source, destination);
}
process.env.PATH = path.join(modules, '.bin') + ':' + process.env.PATH;
Object.assign(process.env, { CI: '1', NEXT_TELEMETRY_DISABLED: '1', EXPO_NO_TELEMETRY: '1',
  EXPO_OFFLINE: '1', npm_config_offline: 'true', npm_config_cache: '/tmp/npm-cache',
  DATABASE_URL: 'postgresql://validation:validation@127.0.0.1:5432/validation',
  NEXTAUTH_URL: 'http://localhost:3000', NEXTAUTH_SECRET: 'validation-only-not-a-live-secret',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000', EXPO_PUBLIC_SUPERTOKENS_ENABLED: '1',
  EXPO_PUBLIC_API_BASE_URL: 'http://localhost:3000' });
if (process.argv[2] === 'build') process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/validation';
function run(command) {
  const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
  if (r.error || r.signal) { console.error('CHECK_PROCESS:', r.error?.message || r.signal); process.exit(1); }
  if (r.status !== 0) process.exit(r.status || 1);
}
if (config.prisma) run(['node', 'node_modules/prisma/build/index.js', 'generate']);
const check = process.argv[2];
if (check === 'probe') {
  for (const name of config.required_packages) require.resolve(name + '/package.json', { paths: [root] });
  console.log('VALIDATION_READY ' + config.project); process.exit(0);
}
if (!Object.hasOwn(config.commands, check)) throw new Error('unknown validation check');
run(config.commands[check]);
