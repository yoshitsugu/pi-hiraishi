import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { installHostBridge, HOST_TOOL, type HostExec } from './host-bridge.ts';
import { canonicalPath, validateConfig, type Config, type HostCommand } from './policy.ts';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';

const commands: HostCommand[] = [
  {
    name: 'hc', path: '/usr/bin/hc', starts: 'run', operations: [
      { name: 'run', argv: ['run', '--bg', '--name', '{name}', '--cwd', '{cwd}', 'pi', '-e', '{hiraishi}', '--hiraishi-grants', '{grants}', '{task}'] },
      { name: 'send', argv: ['send', '{name}', '{task}'] },
      { name: 'read', argv: ['read', '--lines', '{lines}', '{name}'] },
      { name: 'list', argv: ['ls'] },
    ],
  },
  {
    name: 'itest', path: '/usr/bin/itest', delegable: true, operations: [
      { name: 'run', argv: ['run', '{cwd}', '{task}'] },
    ],
  },
];

interface Harness {
  calls: { bin: string; args: string[]; timeout: number; env?: string[] }[]; ctx: ExtensionToolContext;
  setFailed(value: boolean): void; reset(): void;
  run(input: Record<string, unknown>, signal?: AbortSignal): Promise<{ details: { status: string }; content: { text: string }[] }>;
}

function harness(configured: HostCommand[], roots: string[], options: { baseline?: Config; denyRead?: string[]; ceiling?: { networkMode: 'off' | 'http-get' | 'http-all'; readOnly: string[]; readWrite: string[] }; ctx?: ExtensionToolContext; real?: boolean } = {}): Harness {
  const tools = new Map<string, any>();
  const calls: { bin: string; args: string[]; timeout: number; env?: string[] }[] = [];
  let failed = false;
  const exec: HostExec = async (bin, args, execOptions) => {
    if (execOptions.signal?.aborted) return { output: '', failed: false, aborted: true };
    calls.push({ bin, args, timeout: execOptions.timeout, env: execOptions.env });
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
    ...(options.real ? {} : { exec }),
  });
  loading = false;
  const ctx = options.ctx ?? ({} as ExtensionToolContext);
  return {
    calls,
    ctx,
    setFailed: (value: boolean) => { failed = value; },
    reset: () => installed.reset(),
    run: (input, signal) => tools.get(HOST_TOOL).execute('id', input, signal, undefined, ctx) as Promise<{ details: { status: string }; content: { text: string }[] }>,
  };
}

const setup = () => {
  const root = mkdtempSync('/tmp/hiraishi-host-');
  for (const dir of ['workspace', 'docs', 'cache', 'other', 'outside']) mkdirSync(`${root}/${dir}`);
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

test('a host command receives its configured environment names in addition to the fixed set', async () => {
  const { root, roots, baseline } = setup();
  try {
    const h = harness([{ ...commands[0]!, env: ['EXAMPLE_TOKEN', 'example_token'] }], roots, { baseline });
    const outcome = await h.run({ command: 'hc', operation: 'list' });
    assert.equal(outcome.details.status, 'complete');
    assert.deepEqual(h.calls[0]!.env, ['EXAMPLE_TOKEN', 'example_token']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only configured environment values that exist on the host are passed to the program', async () => {
  const { root, roots, baseline } = setup();
  const visible = 'HIRAISHI_TEST_HOST_ENV_VISIBLE';
  const absent = 'HIRAISHI_TEST_HOST_ENV_ABSENT';
  const previous = process.env[visible];
  process.env[visible] = 'visible-value';
  delete process.env[absent];
  try {
    const h = harness([{ name: 'env', path: '/usr/bin/env', env: [visible, absent], operations: [{ name: 'show', argv: ['env'] }] }], roots, { baseline, real: true });
    const outcome = await h.run({ command: 'env', operation: 'show' });
    assert.equal(outcome.details.status, 'complete');
    assert.match(outcome.content[0]!.text, new RegExp(`^${visible}=visible-value$`, 'm'));
    assert.doesNotMatch(outcome.content[0]!.text, new RegExp(`^${absent}=`, 'm'));
    assert.match(outcome.content[0]!.text, /^(HOME|PATH)=/m, 'the fixed host environment is still passed');
  } finally {
    if (previous === undefined) delete process.env[visible]; else process.env[visible] = previous;
    rmSync(root, { recursive: true, force: true });
  }
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

test('child denyRead can hide paths inside its workspace and missing paths are accepted', async () => {
  const { root, roots, baseline } = setup();
  try {
    const h = harness(commands, roots, { baseline, denyRead: [`${root}/docs/parent-secret`], ceiling: { networkMode: 'off', readOnly: [`${root}/docs`], readWrite: [`${root}/cache`] } });
    const started = await h.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 't', grants: JSON.stringify({
      denyRead: [`${root}/workspace/.env`, `${root}/workspace/missing`, `${root}/docs/child-secret`],
    }) });
    assert.equal(started.details.status, 'complete');
    const child = JSON.parse(h.calls[0]!.args[10]!);
    assert.deepEqual(new Set(child.denyRead), new Set([
      `${root}/docs/parent-secret`, `${root}/workspace/.env`, `${root}/workspace/missing`, `${root}/docs/child-secret`,
    ]));
    assert.equal(child.cwd, `${root}/workspace`);
    assert.equal('workspace' in child, false, 'the hosted child uses cwd as its workspace');
    assert.deepEqual(child.replace.readOnly, [`${root}/docs`]);
    assert.deepEqual(child.replace.readWrite, [`${root}/cache`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('host children receive only delegable commands and cannot select hostCommands', async () => {
  const { root, roots, baseline } = setup();
  try {
    const configured = validateConfig({ ...baseline, hostCommands: commands });
    const h = harness(commands, roots, { baseline: configured });
    await h.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 't' });
    const child = JSON.parse(h.calls[0]!.args[10]!);
    assert.equal(child.noHostCommands, true);
    assert.deepEqual(child.hostCommands, ['itest']);

    const selected = await h.run({ command: 'hc', operation: 'run', name: 'fix2', cwd: `${root}/workspace`, task: 't', grants: JSON.stringify({ hostCommands: ['itest'] }) });
    assert.equal(selected.details.status, 'blocked');
    assert.match(selected.content[0]!.text, /hostCommands cannot be selected/);
    assert.equal(h.calls.length, 1);

    const plain = harness([commands[0]!], roots, { baseline: configured });
    await plain.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 't' });
    const noDelegable = JSON.parse(plain.calls[0]!.args[10]!);
    assert.equal(noDelegable.noHostCommands, true);
    assert.equal(noDelegable.hostCommands, undefined);

    const childSession = harness([commands[1]!], roots, { baseline: configured });
    const grandchild = await childSession.run({ command: 'hc', operation: 'run', name: 'grand', cwd: `${root}/workspace`, task: 't' });
    assert.equal(grandchild.details.status, 'blocked');
    assert.match(grandchild.content[0]!.text, /Unknown host command hc/);
    assert.equal(childSession.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a delegable command that can start another child is not passed further', async () => {
  const { root, roots, baseline } = setup();
  try {
    const leaking: HostCommand = { name: 'leak', path: '/usr/bin/leak', delegable: true, operations: [{ name: 'run', argv: ['run', '{hiraishi}', '{grants}'] }] };
    const configured = validateConfig({ ...baseline, hostCommands: commands });
    const h = harness([...commands, leaking], roots, { baseline: configured });
    await h.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/workspace`, task: 't' });
    const child = JSON.parse(h.calls[0]!.args[10]!);
    assert.deepEqual(child.hostCommands, ['itest']);
    assert(!child.hostCommands.includes('leak'));
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

const uiContext = (select: (title: string, options: string[]) => Promise<string | undefined>) =>
  ({ hasUI: true, ui: { select, notify() {}, setStatus() {} } } as unknown as ExtensionToolContext);

test('a cwd inside the configured write ceiling runs without asking and child grants carry no ceiling', async () => {
  const { root, roots, baseline } = setup();
  try {
    const h = harness(commands, roots, {
      baseline,
      ceiling: { networkMode: 'http-get', readOnly: [`${root}/docs`], readWrite: [`${root}/cache`, `${root}/other`] },
    });
    const started = await h.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/other`, task: 't', grants: JSON.stringify({ readOnly: [`${root}/docs`] }) });
    assert.equal(started.details.status, 'complete');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.args[5], `${root}/other`);
    const child = JSON.parse(h.calls[0]!.args[10]!);
    assert.equal(child.noHostCommands, true);
    assert(!('maxReadOnly' in child));
    assert(!('maxReadWrite' in child));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a cwd outside the write ceiling asks the user with the command, cwd, child grants and task', async () => {
  const { root, roots, baseline } = setup();
  try {
    const prompts: string[] = [];
    const h = harness(commands, roots, {
      baseline,
      ceiling: { networkMode: 'http-get', readOnly: [`${root}/docs`], readWrite: [`${root}/cache`] },
      ctx: uiContext(async (title, options) => {
        prompts.push(title);
        assert.deepEqual(options, ['Run in this directory', 'Refuse']);
        return 'Run in this directory';
      }),
    });
    const started = await h.run({ command: 'hc', operation: 'run', name: 'fix', cwd: `${root}/outside`, task: 'Fix\tit\nnow', grants: JSON.stringify({ readOnly: [`${root}/docs`] }) });
    assert.equal(started.details.status, 'complete');
    assert.equal(prompts.length, 1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.args[5], `${root}/outside`);
    const title = prompts[0]!;
    assert.match(title, /Command: hc run/);
    assert(title.includes(`Working directory: ${root}/outside`));
    assert(title.includes(h.calls[0]!.args[10]!), 'the dialog shows the grants that the child actually receives');
    assert.match(title, /Task: Fix\\u\{9\}it\\u\{a\}now/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a refused or unavailable outside workspace blocks, and a dismissed dialog cancels', async () => {
  const { root, roots, baseline } = setup();
  const scope = { networkMode: 'http-get' as const, readOnly: [`${root}/docs`], readWrite: [`${root}/cache`] };
  const input = (cwd: string) => ({ command: 'hc', operation: 'run', name: 'fix', cwd, task: 't' });
  try {
    const refused = harness(commands, roots, { baseline, ceiling: scope, ctx: uiContext(async () => 'Refuse') });
    const blocked = await refused.run(input(`${root}/outside`));
    assert.equal(blocked.details.status, 'blocked');
    assert.match(blocked.content[0]!.text, /refused/);
    assert.equal(refused.calls.length, 0);

    const closed = harness(commands, roots, { baseline, ceiling: scope });
    const unavailable = await closed.run(input(`${root}/outside`));
    assert.equal(unavailable.details.status, 'blocked');
    assert.match(unavailable.content[0]!.text, /write ceiling/);
    assert.match(unavailable.content[0]!.text, /maxReadWrite/);
    assert.match(unavailable.content[0]!.text, /read-only grant/);
    assert.equal(closed.calls.length, 0);

    const dismissed = harness(commands, roots, { baseline, ceiling: scope, ctx: uiContext(async () => undefined) });
    const cancelled = await dismissed.run(input(`${root}/outside`));
    assert.equal(cancelled.details.status, 'cancelled');
    assert.equal(dismissed.calls.length, 0);

    const prompts: string[] = [];
    const missing = harness(commands, roots, { baseline, ceiling: scope, ctx: uiContext(async title => { prompts.push(title); return 'Run in this directory'; }) });
    const absent = await missing.run(input(`${root}/outside/missing`));
    assert.equal(absent.details.status, 'blocked');
    assert.match(absent.content[0]!.text, /not an existing directory/);
    assert.equal(prompts.length, 0);
    assert.equal(missing.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
