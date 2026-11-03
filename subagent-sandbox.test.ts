import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.deepEqual(h.created[0]!.config, { ...defaults, denyRead: ['/project/.env'], socatPath: '/custom/socat' });
  assert.deepEqual(h.created[1]!.config, { ...grants, denyRead: ['/project/.env'], socatPath: '/custom/socat' });
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
