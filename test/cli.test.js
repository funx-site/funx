'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../cli/funx');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'cli', 'funx.js');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', HOME: os.tmpdir() },
  });
}

test('funx help prints the worker commands and exits 0', () => {
  for (const args of [[], ['-h'], ['--help']]) {
    const r = run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /funx dev \[dir\|file\]/);
    assert.match(r.stdout, /funx deploy <dir> --name <name>/);
    assert.match(r.stdout, /funx secret put <name> <KEY>/);
    assert.match(r.stdout, /funx var set <name> <KEY> <value>/);
    assert.match(r.stdout, /funx api-build/);
    assert.match(r.stdout, /funx runtime-build --api/);
    assert.match(r.stdout, /funx router-deploy/);
    assert.equal(r.stderr, '');
  }
});

test('local commands reject missing args before any cloud call', () => {
  const user = run(['user-hash']);
  assert.equal(user.status, 1);
  assert.match(user.stderr, /usage: echo -n <password> \| funx user-hash <email> <id> \[admin\]/);

  const secrets = run(['runtime-secrets']);
  assert.equal(secrets.status, 1);
  assert.match(secrets.stderr, /usage: funx runtime-secrets <dir>/);

  const unknown = run(['no-such-command']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /FUNX_DEPLOY_KEY is not set/);
  assert.doesNotMatch(unknown.stderr, /tencentcloudapi|RequestId|ENOTFOUND/i);
});

test('operator commands stop on the local deploy-key gate', () => {
  for (const args of [
    ['deploy', './examples/worker'],
    ['deploy', './examples/worker', '--name', 'hello'],
    ['list'],
    ['secret', 'list', 'hello'],
    ['var', 'set', 'hello', 'GREETING', 'hi'],
    ['router-deploy'],
  ]) {
    const r = run(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /FUNX_DEPLOY_KEY is not set/);
    assert.doesNotMatch(r.stderr, /tencentcloudapi|RequestId|ENOTFOUND/i);
  }
});

test('runtime-build parses --api and does not write a zip when it is missing', async () => {
  const out = path.join(os.tmpdir(), `funx-runtime-cli-${process.pid}.zip`);
  await assert.rejects(
    () => main(['runtime-build', out, '--api', 'http://insecure.example']),
    /runtime-build needs --api https:\/\//,
  );
  assert.equal(fs.existsSync(out), false);
  await assert.rejects(() => main(['runtime-build']), /runtime-build needs --api https:\/\//);
});

test('dev parses --var locally and rejects a bad name before listen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funx-cli-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export default { fetch() { return new Response("ok"); } };\n');
  await assert.rejects(
    () => main(['dev', dir, '--port', '8787', '--var', 'BAD-NAME=1']),
    /BAD-NAME/,
  );
});

test('package.json bin.funx points at the shebang entry', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.funx, 'cli/funx.js');
  assert.equal(pkg.private, true);
  const src = fs.readFileSync(cli, 'utf8');
  assert.match(src, /^#!\/usr\/bin\/env node\n/);
  assert.ok(fs.statSync(cli).mode & 0o111);
});
