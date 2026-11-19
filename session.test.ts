import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { validateConfig } from './policy.ts';
import { SandboxSession } from './session.ts';

const session = (config: ReturnType<typeof validateConfig>) => new SandboxSession('/tmp', '/tmp/hiraishi-ceiling-config', config, '/tmp');

test('the configured maximum, not the startup mode, bounds network changes', async () => {
  const config = validateConfig({ networkMode: 'off', maxNetworkMode: 'http-get' });
  const active = session(config);
  assert.equal(active.ceilingMode, 'http-get');
  await assert.rejects(active.changeMode('http-all'), /exceeds this session's ceiling/);
  await assert.rejects(active.changeMode('http-get'), /Sandbox is not started/);
});

test('defaults keep the human able to raise the network mode', async () => {
  const active = session(validateConfig({ networkMode: 'off' }));
  assert.equal(active.ceilingMode, 'http-all');
  await assert.rejects(active.changeMode('http-all'), /Sandbox is not started/);
});

test('a session refuses a cwd that does not resolve to itself', async () => {
  const root = mkdtempSync('/tmp/hiraishi-cwd-');
  try {
    mkdirSync(`${root}/project`);
    symlinkSync(`${root}/project`, `${root}/alias`);
    const linked = new SandboxSession(`${root}/alias`, `${root}/config`, validateConfig({ networkMode: 'off' }), '/tmp');
    await assert.rejects(linked.start(), /does not resolve to itself/);
    assert.equal(linked.status, 'failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
