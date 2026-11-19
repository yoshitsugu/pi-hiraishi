import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { SubagentSandboxes } from './subagent-sandbox.ts';
import { validateConfig } from './policy.ts';
import type { SandboxSession } from './session.ts';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';

const defaults = { networkMode: 'off' as const, readOnly: [], readWrite: [] };
function harness() {
  const parent = { cwd: '/project', configPath: '/config.json', agentDir: '/agent', config: validateConfig({
    networkMode: 'http-all', readOnly: ['/reference'], readWrite: ['/cache'], denyRead: ['/project/.env'], socatPath: '/custom/socat',
  }) } as SandboxSession;
  const created: SandboxSession[] = [];
  const sandboxes = new SubagentSandboxes((source, config) => {
    const fixture = { cwd: source.cwd, config, status: 'stopped',
      async start() { this.status = 'ready'; }, async stop() { this.status = 'stopped'; },
    };
    const child = fixture as unknown as SandboxSession;
    created.push(child);
    return child;
  });
  const observed: SandboxSession[] = [];
  const ctx = { executeTool: async () => {
    observed.push(sandboxes.current(parent));
    await Promise.resolve();
    observed.push(sandboxes.current(parent));
    return { isError: false, result: { content: [], details: {} } };
  } } as unknown as ExtensionToolContext;
  return { parent, sandboxes, created, observed, ctx };
}

test('separate children retain denies but do not inherit parent grants or leak scope', async () => {
  const h = harness();
  const first = await h.sandboxes.open(h.parent, h.ctx, defaults, new AbortController().signal);
  const grants = { networkMode: 'http-get' as const, readOnly: ['/other'], readWrite: [] };
  const second = await h.sandboxes.open(h.parent, h.ctx, grants, new AbortController().signal);
  assert.deepEqual(h.created[0]!.config, { ...defaults, networkMode: defaults.networkMode, maxNetworkMode: defaults.networkMode, maxReadOnly: [], maxReadWrite: [], denyRead: ['/project/.env'], socatPath: '/custom/socat' });
  assert.deepEqual(h.created[1]!.config, { ...grants, maxNetworkMode: grants.networkMode, maxReadOnly: [], maxReadWrite: [], denyRead: ['/project/.env'], socatPath: '/custom/socat' });
  await Promise.all([first.executeTool('read', {}), second.executeTool('read', {})]);
  assert.deepEqual(h.observed, [h.created[0], h.created[1], h.created[0], h.created[1]]);
  assert.equal(h.sandboxes.current(h.parent), h.parent);
  await first.close();
  await assert.rejects(first.executeTool('read', {}), /unavailable/);
  assert.equal(h.created[1]!.status, 'ready');
  await h.sandboxes.stop();
  assert.equal(h.created[1]!.status, 'stopped');
  await second.close();
});

test('child denyRead is unioned and workspace is canonicalized or refused', async () => {
  const root = mkdtempSync('/tmp/hiraishi-child-workspace-');
  const created: { cwd: string; config: any; status: string }[] = [];
  const children = new SubagentSandboxes((source, config, cwd) => {
    const child = { cwd, config, status: 'stopped', async start() { this.status = 'ready'; }, async stop() { this.status = 'stopped'; } };
    created.push(child);
    return child as unknown as SandboxSession;
  });
  try {
    for (const dir of ['project', 'project/sub', 'project/other', 'outside']) mkdirSync(`${root}/${dir}`);
    symlinkSync(`${root}/outside`, `${root}/project/escape`);
    symlinkSync(`${root}/project/sub`, `${root}/project/alias`);
    const parent = { cwd: `${root}/project`, configPath: `${root}/config.json`, agentDir: '/agent',
      config: validateConfig({ networkMode: 'off', denyRead: [`${root}/project/.env`] }) } as SandboxSession;
    const ctx = { executeTool: async () => ({ isError: false, result: { content: [], details: {} } }) } as unknown as ExtensionToolContext;
    const child = await children.open(parent, ctx, {
      networkMode: 'off', readOnly: [], readWrite: [],
      denyRead: [`${root}/project/.hidden`], workspace: `${root}/project/alias`,
    }, new AbortController().signal);
    assert.equal(created[0]!.cwd, `${root}/project/sub`);
    assert.deepEqual(new Set(created[0]!.config.denyRead), new Set([`${root}/project/.env`, `${root}/project/.hidden`]));
    assert.equal(created[0]!.config.maxNetworkMode, 'off');
    await child.close();
    for (const workspace of [`${root}/outside`, `${root}/project/escape`, `${root}/project/missing`])
      await assert.rejects(children.open(parent, ctx, { networkMode: 'off', readOnly: [], readWrite: [], workspace }, new AbortController().signal), /Invalid workspace/);
    await assert.rejects(children.open(parent, ctx, { networkMode: 'off', readOnly: [], readWrite: [], denyRead: 'not-an-array' as any }, new AbortController().signal), /expected an array/);
    assert.equal(created.length, 1);
  } finally {
    await children.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('aborted runs stop their sandbox and never restore parent permissions', async () => {
  const h = harness();
  const controller = new AbortController();
  const child = await h.sandboxes.open(h.parent, h.ctx, defaults, controller.signal);
  controller.abort();
  assert.equal(h.created[0]!.status, 'stopped');
  await assert.rejects(child.executeTool('read', {}), /unavailable/);
  await child.close();
  await assert.rejects(h.sandboxes.open(h.parent, h.ctx, defaults, controller.signal), /cancelled/);
  assert.equal(h.created[1]!.status, 'stopped');
});

test('failed startup is cleaned up and failed teardown remains observable', async () => {
  const h = harness();
  const child = { async start() { throw new Error('startup refused'); }, async stop() {} } as unknown as SandboxSession;
  let stopped = 0;
  child.stop = async () => { stopped++; };
  const sandboxes = new SubagentSandboxes(() => child);
  await assert.rejects(sandboxes.open(h.parent, h.ctx, defaults, new AbortController().signal), /startup refused/);
  assert.equal(stopped, 1);
  child.start = async () => {};
  const runtime = await sandboxes.open(h.parent, h.ctx, defaults, new AbortController().signal);
  child.stop = async () => { throw new Error('cleanup failed'); };
  await assert.rejects(runtime.close(), /cleanup failed/);
  await assert.rejects(sandboxes.stop(), /cleanup failed/);
  child.stop = async () => {};
  await sandboxes.stop();
});
