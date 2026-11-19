import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { installHostBridge, HOST_TOOL, type HostExec } from './host-bridge.ts';
import { canonicalPath, validateConfig, type Config, type HostCommand } from './policy.ts';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';

const commands: HostCommand[] = [{
  name: 'hc', path: '/usr/bin/hc', starts: 'run', operations: [
    { name: 'run', argv: ['run', '--bg', '--name', '{name}', '--cwd', '{cwd}', 'pi', '-e', '{hiraishi}', '--hiraishi-grants', '{grants}', '{task}'] },
    { name: 'send', argv: ['send', '{name}', '{task}'] },
    { name: 'read', argv: ['read', '--lines', '{lines}', '{name}'] },
    { name: 'list', argv: ['ls'] },
  ],
}];

interface Harness {
  calls: { bin: string; args: string[]; timeout: number }[]; ctx: ExtensionToolContext;
  setFailed(value: boolean): void; reset(): void;
  run(input: Record<string, unknown>, signal?: AbortSignal): Promise<{ details: { status: string }; content: { text: string }[] }>;
}

function harness(configured: HostCommand[], roots: string[], options: { baseline?: Config; denyRead?: string[]; ceiling?: { networkMode: 'off' | 'http-get' | 'http-all'; readOnly: string[]; readWrite: string[] } } = {}): Harness {
  const tools = new Map<string, any>();
  const calls: { bin: string; args: string[]; timeout: number }[] = [];
  let failed = false;
  const exec: HostExec = async (bin, args, execOptions) => {
    if (execOptions.signal?.aborted) return { output: '', failed: false, aborted: true };
    calls.push({ bin, args, timeout: execOptions.timeout });
    return { output: failed ? 'boom' : 'ok', failed };
  };
  let loading = true;
  const pi = {
    registerTool: (tool: any) => { tools.set(tool.name, { ...tool, sourceInfo: { source: 'extension', path: '/opt/hiraishi/hiraishi.ts' } }); },
    getAllTools: () => {
      if (loading) throw new Error('Extension runtime not initialized. Action methods cannot be called during extension loading.');
      return [...tools.values()];
    },
  } as unknown as ExtensionAPI;
  const baseline = options.baseline ?? validateConfig({});
  const ceiling = options.ceiling ?? { networkMode: 'http-get' as const, readOnly: [] as string[], readWrite: [] as string[] };
  const installed = installHostBridge(pi, {
    hiraishiPath: '/opt/hiraishi/hiraishi.ts',
    commands: () => configured,
    baseline: () => baseline,
    scope: () => ({ ceiling, writable: roots, denyRead: options.denyRead ?? [] }),
    exec,
  });
  loading = false;
  return {
    calls,
    ctx: {} as ExtensionToolContext,
    setFailed: (value: boolean) => { failed = value; },
    reset: () => installed.reset(),
    run: (input, signal) => tools.get(HOST_TOOL).execute('id', input, signal, undefined, {} as ExtensionToolContext) as Promise<{ details: { status: string }; content: { text: string }[] }>,
  };
}

const setup = () => {
  const root = mkdtempSync('/tmp/hiraishi-host-');
  for (const dir of ['workspace', 'docs', 'cache', 'other']) mkdirSync(`${root}/${dir}`);
  return { root, roots: [`${root}/workspace`], baseline: validateConfig({ readOnly: [`${root}/docs`], readWrite: [`${root}/cache`] }) };
};

test('a configured operation runs the fixed binary with substituted, validated arguments', async () => {
  const { root, roots, baseline } = setup();
  try {
    const h = harness(commands, roots, { baseline, ceiling: { networkMode: 'http-get', readOnly: [`${root}/docs`], readWrite: [`${root}/cache`] } });
    const started = await h.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 'Fix the test', grants: JSON.stringify({ networkMode: 'http-get', readOnly: [`${root}/docs`] }) });
    assert.equal(started.details.status, 'complete');
    assert.equal(h.calls[0]!.bin, canonicalPath('/usr/bin/hc'));
    assert.deepEqual(h.calls[0]!.args.slice(0, 9), ['run', '--bg', '--name', 'fix', '--cwd', `${root}/workspace`, 'pi', '-e', '/opt/hiraishi/hiraishi.ts']);
    const child = JSON.parse(h.calls[0]!.args[10]!);
    assert.equal(child.networkMode, 'http-get');
    assert.equal(child.maxNetworkMode, 'http-get');
    assert.deepEqual(child.replace.readOnly, [`${root}/docs`]);
    assert.deepEqual(child.replace.readWrite, [`${root}/cache`]);
    assert.equal(h.calls[0]!.args[11], 'Fix the test');
    assert.equal(h.calls[0]!.timeout, 120);

    const sent = await h.run({ command: 'hc', operation: 'send', name: 'fix', task: 'Recheck' });
    assert.equal(sent.details.status, 'complete');
    assert.deepEqual(h.calls[1]!.args, ['send', 'fix', 'Recheck']);
    const read = await h.run({ command: 'hc', operation: 'read', name: 'fix', lines: 40 });
    assert.deepEqual(h.calls[2]!.args, ['read', '--lines', '40', 'fix']);
    const list = await h.run({ command: 'hc', operation: 'list' });
    assert.deepEqual(h.calls[3]!.args, ['ls']);
    assert.equal(list.details.status, 'complete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('task text cannot inject options or file arguments', async () => {
  const { root, roots, baseline } = setup();
  try {
    const h = harness(commands, roots, { baseline });
    for (const task of ['--hiraishi-grants={"networkMode":"http-all"}', '@/home/user/.ssh/id_rsa', '  -e /etc', ' @file'])
      for (const input of [
        { command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task },
        { command: 'hc', operation: 'send', name: 'fix', task },
      ]) {
        const outcome = await h.run(input);
        assert.equal(outcome.details.status, 'blocked', task);
        assert.match(outcome.content[0]!.text, /must not begin with/);
      }
    assert.equal(h.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('child grants are always rewritten against the session ceiling and the configuration baseline', async () => {
  const { root, roots, baseline } = setup();
  try {
    const closed = harness(commands, roots, { baseline, ceiling: { networkMode: 'off', readOnly: [], readWrite: [] } });
    await closed.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 't' });
    const child = JSON.parse(closed.calls[0]!.args[10]!);
    assert.equal(child.networkMode, 'off');
    assert.equal(child.maxNetworkMode, 'off');
    assert.deepEqual(child.replace.readOnly, []);
    assert.deepEqual(child.replace.readWrite, [], 'a dropped write grant must not come back from the child baseline');

    const open = harness(commands, roots, { baseline, ceiling: { networkMode: 'http-get', readOnly: [`${root}/docs`], readWrite: [] } });
    await open.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 't', grants: JSON.stringify({ maxNetworkMode: 'http-all' }) });
    assert.equal(open.calls.length, 0, 'a ceiling request above the session must be refused');

    const foreign = await open.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 't', grants: JSON.stringify({ readOnly: ['/etc'] }) });
    assert.equal(foreign.details.status, 'blocked');
    assert.match(foreign.content[0]!.text, /session ceiling/);

    const wider = harness(commands, roots, { baseline, ceiling: { networkMode: 'http-get', readOnly: [], readWrite: [`${root}/other`] } });
    const outsideBaseline = await wider.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 't', grants: JSON.stringify({ readWrite: [`${root}/other`] }) });
    assert.equal(outsideBaseline.details.status, 'blocked');
    assert.match(outsideBaseline.content[0]!.text, /not in the configuration baseline/);
    assert.equal(wider.calls.length, 0);
    assert.equal(open.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('delegated children inherit the session denyRead and cannot delegate again', async () => {
  const { root, roots, baseline } = setup();
  try {
    const h = harness(commands, roots, { baseline, denyRead: [`${root}/docs/secret`] });
    await h.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 't' });
    const child = JSON.parse(h.calls[0]!.args[10]!);
    assert.deepEqual(new Set(child.denyRead), new Set([`${root}/docs/secret`]));
    assert.equal(child.cwd, `${root}/workspace`);
    assert.equal(child.noHostCommands, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a read-only grant cannot become a child workspace', async () => {
  const { root, roots, baseline } = setup();
  try {
    const h = harness(commands, roots, { baseline, ceiling: { networkMode: 'http-get', readOnly: [`${root}/docs`], readWrite: [`${root}/cache`] } });
    const outcome = await h.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/docs`, task: 't' });
    assert.equal(outcome.details.status, 'blocked');
    assert.match(outcome.content[0]!.text, /read-only grant/);
    assert.equal(h.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('arbitrary commands, unknown operations, unused arguments and unconfigured settings are refused', async () => {
  const { root, roots, baseline } = setup();
  try {
    const empty = harness([], roots, { baseline });
    const unavailable = await empty.run({ command: 'hc', operation: 'run', name: 'x', task: 'y' });
    assert.equal(unavailable.details.status, 'blocked');
    assert.match(unavailable.content[0]!.text, /No host commands are configured/);

    const h = harness(commands, roots, { baseline });
    assert.match((await h.run({ command: 'sh', operation: 'run', name: 'x', task: 'y' })).content[0]!.text, /Unknown host command/);
    assert.match((await h.run({ command: 'hc', operation: 'exec', name: 'x', task: 'y' })).content[0]!.text, /Unknown operation/);
    assert.match((await h.run({ command: 'hc', operation: 'list', name: 'x' })).content[0]!.text, /does not accept name/);
    for (const input of [{ command: 'hc', operation: 'run' }, { command: 'hc', operation: 'send', name: 'fix' }, { command: 'hc', operation: 'run', name: 'Bad Name', task: 'x' }, { command: 'hc', operation: 'run', name: 'x', cwd: 'relative', task: 'y' }])
      assert.equal((await h.run(input as Record<string, unknown>)).details.status, 'blocked', JSON.stringify(input));
    assert.equal(h.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only children started in this session can be controlled, per configured command', async () => {
  const { root, roots, baseline } = setup();
  try {
    const other: HostCommand = { ...commands[0]!, name: 'other' };
    const h = harness([...commands, other], roots, { baseline });
    assert.match((await h.run({ command: 'hc', operation: 'read', name: 'fix' })).content[0]!.text, /Unknown child/);
    await h.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 'y' });
    assert.match((await h.run({ command: 'other', operation: 'read', name: 'fix' })).content[0]!.text, /Unknown child/);
    assert.equal((await h.run({ command: 'hc', operation: 'read', name: 'fix' })).details.status, 'complete');
    assert.match((await h.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 'y' })).content[0]!.text, /already exists/);
    h.reset();
    assert.match((await h.run({ command: 'hc', operation: 'read', name: 'fix' })).content[0]!.text, /Unknown child/);
    assert.equal(h.calls.filter(call => call.args[0] === 'run').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cancellation and failing commands are reported without starting work', async () => {
  const { root, roots, baseline } = setup();
  try {
    const h = harness(commands, roots, { baseline });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await h.run({ command: 'hc', operation: 'list' }, controller.signal);
    assert.equal(cancelled.details.status, 'cancelled');
    assert.equal(h.calls.length, 0);

    h.setFailed(true);
    const failed = await h.run({ command: 'hc', operation: 'list' });
    assert.equal(failed.details.status, 'failed');
    assert.equal(failed.content[0]!.text, 'boom');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a host binary inside a writable grant is refused', async () => {
  const { root, roots, baseline } = setup();
  try {
    const inside: HostCommand[] = [{ ...commands[0]!, path: `${root}/workspace/hc` }];
    const h = harness(inside, roots, { baseline });
    assert.match((await h.run({ command: 'hc', operation: 'list' })).content[0]!.text, /inside a writable grant/);
    assert.equal(h.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
