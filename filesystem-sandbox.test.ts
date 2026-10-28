import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createFilesystemOperations, executeSandbox, filesystemSandboxPlan, validateFilesystemSandbox } from './filesystem-sandbox.ts';

const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HIRAISHI_CONFIG: process.env.HIRAISHI_CONFIG };
const root = mkdtempSync(join(process.cwd(), '.hiraishi-sandbox-test-'));
const home = join(root, 'home');
const project = join(root, 'project');
const agent = join(home, '.pi/agent');
const outside = join(root, 'outside');
const extraRead = join(root, 'read-only');
const extraWrite = join(root, 'read-write');
const temp = mkdtempSync('/tmp/hiraishi-sandbox-test-');
for (const path of [project, agent, outside, extraRead, extraWrite, join(project, '.git/hooks'), join(home, '.agents/skills/example')]) mkdirSync(path, { recursive: true });
process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = agent;
const configPath = join(agent, 'hiraishi/config.json'); mkdirSync(join(agent, 'hiraishi'));
process.env.HIRAISHI_CONFIG = configPath;
writeFileSync(configPath, '{}');
writeFileSync(join(agent, 'auth.json'), '{}');
writeFileSync(join(agent, 'settings.json'), '{}');
writeFileSync(join(home, '.agents/skills/example/SKILL.md'), '# Synthetic skill');
writeFileSync(join(outside, 'secret'), 'synthetic secret fixture');
writeFileSync(join(extraRead, 'sample'), 'extra read');
writeFileSync(join(extraWrite, 'sample'), 'extra write');
writeFileSync(join(project, '.git/hooks/example'), 'original hook');
symlinkSync(outside, join(project, 'outside-link'));
after(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(root, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true });
});
const operations = createFilesystemOperations(project, {}, configPath);
const launch = (command: string) => filesystemSandboxPlan(project, {}, configPath, '/bin/bash', ['--noprofile', '--norc', '-c', command]);
const probe = spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--', '/bin/true'], { encoding: 'utf8' });
const available = probe.status === 0;
if (!available && process.env.HIRAISHI_REQUIRE_BWRAP === '1') throw new Error(`bubblewrap test prerequisite failed: ${probe.stderr || probe.error}`);
const integration = available ? test : (name: string, fn: () => Promise<void>) => test(name, { skip: `bubblewrap unavailable: ${probe.stderr || probe.error}` }, fn);

async function bash(command: string) {
  let output = '';
  const result = await operations.bash.exec(command, project, { onData: data => { output += data.toString(); }, timeout: 5 });
  return { ...result, output };
}

test('filesystem sandbox validates permissions without silently accepting malformed policy', () => {
  for (const value of [null, false, [], { typo: [] }, { enabled: 'false' }, { readOnly: ['/tmp', 1] }, { readWrite: ['relative'] }, { readOnly: ['/tmp\n'] }])
    assert.throws(() => validateFilesystemSandbox(value));
  assert.deepEqual(validateFilesystemSandbox({ readOnly: ['~/skills'], readWrite: ['/tmp'] }), { readOnly: ['~/skills'], readWrite: ['/tmp'] });
  assert.throws(() => filesystemSandboxPlan(project, { readWrite: ['/'] }, configPath, '/bin/true', []));
  assert.throws(() => filesystemSandboxPlan(project, { readOnly: [join(outside, 'secret')] }, configPath, '/bin/true', []));
  assert.throws(() => filesystemSandboxPlan(home, {}, configPath, '/bin/true', []));
  assert.throws(() => filesystemSandboxPlan(project, {}, join(project, 'config.json'), '/bin/true', []));
});

integration('project read/write/edit operations and ordinary build commands work', async () => {
  const path = join(project, 'src/sample.txt');
  await operations.write.mkdir(join(project, 'src'));
  await operations.write.writeFile(path, 'original');
  await operations.read.access(path);
  assert.equal((await operations.read.readFile(path)).toString(), 'original');
  await operations.edit.access(path);
  await operations.edit.writeFile(path, 'edited');
  assert.equal((await operations.edit.readFile(path)).toString(), 'edited');
  const result = await bash('printf "test -f src/sample.txt && printf built > built.txt\\n" > test.sh && /bin/sh test.sh && test -f built.txt');
  assert.equal(result.exitCode, 0, result.output);
});
integration('project-external paths, traversal, symlinks and child scripts stay confined', async () => {
  const secret = join(outside, 'secret');
  for (const path of [secret, join(project, '../outside/secret'), join(project, 'outside-link/secret')]) {
    await assert.rejects(operations.read.readFile(path));
    await assert.rejects(operations.write.writeFile(path, 'overwrite'));
    await assert.rejects(operations.edit.access(path));
  }
  assert.notEqual((await bash(`mkdir -p '${outside}/new-directory'`)).exitCode, 0);
  const result = await bash(`printf 'cat "${secret}"\n' > child.sh; /bin/sh child.sh`);
  assert.notEqual(result.exitCode, 0);
  assert.equal(readFileSync(secret, 'utf8'), 'synthetic secret fixture');
});
integration('/tmp is readable and writable by default, including through bash', async () => {
  const path = join(temp, 'sample');
  await operations.write.writeFile(path, 'temporary');
  assert.equal((await operations.read.readFile(path)).toString(), 'temporary');
  const result = await bash(`printf changed > '${path}'`);
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(readFileSync(path, 'utf8'), 'changed');
});
integration('additional directories distinguish read-only and read-write grants', async () => {
  const additional = createFilesystemOperations(project, { readOnly: [extraRead], readWrite: [extraWrite] }, configPath);
  assert.equal((await additional.read.readFile(join(extraRead, 'sample'))).toString(), 'extra read');
  await assert.rejects(additional.write.writeFile(join(extraRead, 'sample'), 'overwrite'));
  await additional.write.writeFile(join(extraWrite, 'created'), 'allowed');
  assert.equal(readFileSync(join(extraWrite, 'created'), 'utf8'), 'allowed');
});
integration('Pi settings and skills are readable, authentication is masked, configuration and hooks are immutable', async () => {
  assert.equal((await operations.read.readFile(join(agent, 'settings.json'))).toString(), '{}');
  assert.equal((await operations.read.readFile(join(home, '.agents/skills/example/SKILL.md'))).toString(), '# Synthetic skill');
  try { assert.equal((await operations.read.readFile(join(agent, 'auth.json'))).length, 0); }
  catch (error) { assert.match(String(error), /EACCES|EPERM|Permission denied/); }
  for (const path of [configPath, join(agent, 'settings.json'), join(agent, 'auth.json'), join(project, '.git/hooks/example')])
    await assert.rejects(operations.write.writeFile(path, 'overwrite'));
  assert.notEqual((await bash('mv .git .git-moved')).exitCode, 0);
  const result = await bash('mv .git/hooks hooks-moved');
  assert.notEqual(result.exitCode, 0);
  assert.equal(readFileSync(configPath, 'utf8'), '{}');
  assert.equal(readFileSync(join(project, '.git/hooks/example'), 'utf8'), 'original hook');
});
integration('environment credentials are not inherited and host process PIDs cannot be signalled', async () => {
  const saved = process.env.HIRAISHI_DUMMY_SECRET;
  process.env.HIRAISHI_DUMMY_SECRET = 'synthetic-only';
  try {
    const result = await bash('test -z "$HIRAISHI_DUMMY_SECRET" && test -d /proc/1');
    assert.equal(result.exitCode, 0, result.output);
  } finally { if (saved === undefined) delete process.env.HIRAISHI_DUMMY_SECRET; else process.env.HIRAISHI_DUMMY_SECRET = saved; }
  const child = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const closed = once(child, 'close');
  try {
    const result = await bash(`kill -TERM ${child.pid}`);
    assert.notEqual(result.exitCode, 0, result.output);
    assert.equal(child.signalCode, null);
  } finally { child.kill('SIGTERM'); await closed; }
});
integration('startup failures and cancellation never execute the command outside the sandbox', async () => {
  const marker = join(project, 'fallback-marker');
  const plan = launch(`touch '${marker}'`);
  await assert.rejects(executeSandbox({ ...plan, executable: join(root, 'missing-bwrap') }, project));
  const failed = await executeSandbox({ ...plan, args: ['--ro-bind', join(root, 'missing-source'), '/missing', '--', '/bin/bash', '-c', `touch '${marker}'`] }, project);
  assert.notEqual(failed.exitCode, 0);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(executeSandbox(plan, project, { signal: abort.signal }));
  await assert.rejects(executeSandbox(launch('sleep 10'), project, { timeout: 0.05 }));
  assert.equal(existsSync(marker), false);
});

integration('real Pi SDK preserves ALLOW and ASK approval execution within the same sandbox', async () => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { default: extension } = await import('./hiraishi.ts');
  const { ReadOnlyAuthStorage } = await import(new URL('./core/auth-storage.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
  writeFileSync(configPath, JSON.stringify({ endpoint: 'https://classifier.example.invalid/v1/systemone', model: 'fixture-model', registryProvider: 'audit', locale: 'en' }));
  const settingsManager = sdk.SettingsManager.create(project, agent);
  const customMarker = join(outside, 'custom-marker');
  const loader = new sdk.DefaultResourceLoader({ cwd: project, agentDir: agent, settingsManager, noExtensions: true, noContextFiles: true, noThemes: true,
    extensionFactories: [extension, pi => { pi.registerTool({ name: 'unadapted', label: 'Test', description: 'Test fixture', parameters: { type: 'object', properties: {} },
      execute: async () => { writeFileSync(customMarker, 'escaped'); return { content: [], details: {} }; } }); }] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await sdk.ModelRuntime.create({ credentials: new ReadOnlyAuthStorage(join(agent, 'auth.json')), modelsPath: null, allowModelNetwork: false });
  const model = runtime.getModels()[0]!;
  const { session } = await sdk.createAgentSession({ cwd: project, agentDir: agent, modelRuntime: runtime, model, settingsManager, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(project), tools: ['read', 'write', 'edit', 'bash', 'hiraishi_review', 'unadapted'] });
  let approvals = 0;
  await session.bindExtensions({ mode: 'tui', uiContext: {
    notify: () => {}, setStatus: () => {}, setWidget: () => {}, setTitle: () => {},
    select: async (_title: string, choices: string[]) => { approvals++; return choices.find(choice => choice.includes('Allow')) ?? choices[0]; },
    confirm: async () => { approvals++; return true; }, input: async () => undefined, editor: async () => undefined, custom: async () => undefined, setEditorText: () => {},
  } as any, onError: error => { throw new Error(error.error); } });
  session.sessionManager.appendCustomEntry('hiraishi:user-v1', { text: 'Update local source files and run tests. Preserve data outside this project.' });
  const registry = (session as any)._extensionRunner.createContext().modelRegistry;
  let decision = 'ALLOW'; const requests: unknown[] = [];
  registry.getApiKeyForProvider = async () => 'synthetic-fixture-key';
  registry.getRegisteredProviderConfig = () => undefined;
  registry.getModelOfType = () => ({ api: 'typesafe-system-one', baseUrl: 'https://classifier.example.invalid/v1', id: 'fixture-model' });
  registry.classify = async (_model: unknown, context: any) => {
    requests.push(context);
    return { answers: Object.fromEntries(Object.entries(context.questions).map(([name, question]: [string, any]) => {
      const choice = name === 'decision' ? decision : name === 'reason' ? (decision === 'ALLOW' ? 'necessary' : 'uncertain') : 'none';
      const keys = Object.keys(question.criteria);
      return [name, { type: 'choice', choice, confidence: 0.99, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 0.99 : 0.01 / (keys.length - 1)])) }];
    })) };
  };
  let sequence = 0;
  const call = async (name: string, input: Record<string, unknown>) => {
    const id = `fixture-${++sequence}`;
    const assistant = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'toolCall', id, name, arguments: input }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: Date.now() };
    session.sessionManager.appendMessage(assistant as any);
    session.agent.state.messages = [...session.agent.state.messages, assistant as any];
    return (session as any)._executeNestedToolCall(id, name, input);
  };
  const text = (result: any) => result.result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
  try {
    assert.equal((await call('write', { path: join(project, 'sdk.txt'), content: 'SDK_BODY_MARKER' })).isError, false);
    assert.equal(JSON.stringify(requests).includes('SDK_BODY_MARKER'), false, 'write bodies must remain omitted');
    assert.equal((await call('read', { path: join(project, 'sdk.txt') })).isError, false);
    assert.equal((await call('edit', { path: join(project, 'sdk.txt'), edits: [{ oldText: 'SDK_BODY_MARKER', newText: 'edited' }] })).isError, false);
    assert.equal((await call('bash', { command: 'test -f sdk.txt && printf built > sdk-build.txt', timeout: 5 })).isError, false);
    assert.equal((await call('write', { path: join(project, 'generate.cjs'), content: 'require("node:fs").writeFileSync("generated.txt", "synthetic output")' })).isError, false);
    assert.equal((await call('bash', { command: 'node ./generate.cjs', timeout: 5 })).isError, false);
    assert.equal(readFileSync(join(project, 'generated.txt'), 'utf8'), 'synthetic output');
    assert.equal(approvals, 0, 'routine script writes must use classification without mandatory approval');
    assert.equal((await call('read', { path: join(outside, 'secret') })).isError, true);
    assert.equal((await call('write', { path: join(outside, 'secret'), content: 'overwrite' })).isError, true);
    assert.equal((await call('unadapted', {})).isError, true);
    assert.equal(existsSync(customMarker), false);
    assert.equal((await call('read', { path: join(home, '.agents/skills/example/SKILL.md') })).isError, false);
    const initialized = spawnSync('/usr/bin/git', ['init', project], { env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    session.sessionManager.appendCustomEntry('hiraishi:user-v1', { text: 'Commit the current local changes using the existing project author identity.' });
    const committed = await call('bash', { command: "git add -- sdk.txt && git -c user.name='Fixture Maintainer' -c user.email='fixture@users.noreply.github.com' commit -m 'Save fixture'", timeout: 5 });
    assert.equal(committed.isError, false, text(committed));
    assert.equal(approvals, 0, 'ordinary author metadata must not force local approval');
    assert.equal(JSON.stringify(requests).includes('fixture@users.noreply.github.com'), false);
    decision = 'ASK';
    for (const [path, shouldSucceed] of [[join(project, 'approved.txt'), true], [join(outside, 'secret'), false]] as const) {
      const pending = await call('write', { path, content: 'approved fixture' });
      const request = JSON.parse(text(pending));
      assert.equal(request.status, 'ASK_REVIEW_REQUIRED');
      const result = await call('hiraishi_review', { requestId: request.requestId, summary: 'Save a synthetic test file.', reason: 'Check the approval execution path.' });
      assert.equal(result.result.details.hiraishi.status, shouldSucceed ? 'executed' : 'operation_failed_or_blocked', text(result));
    }
    assert.equal(approvals, 2);
    assert.equal(readFileSync(join(project, 'approved.txt'), 'utf8'), 'approved fixture');
    assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'synthetic secret fixture');
  } finally { session.dispose(); writeFileSync(configPath, '{}'); }
});

integration('directory replacement cannot expand a previously granted scope', async () => {
  const { renameSync } = await import('node:fs');
  const mutable = join(root, 'mutable-grant'); mkdirSync(mutable);
  const allowed = createFilesystemOperations(project, { readOnly: [mutable] }, configPath);
  assert.equal((await allowed.bash.exec('true', project, { onData: () => {} })).exitCode, 0);
  renameSync(mutable, mutable + '-original');
  symlinkSync(outside, mutable);
  await assert.rejects(allowed.read.readFile(join(mutable, 'secret')), /permission path changed/);
  const before = launch('true');
  const missing = before.mounts!.find(source => source.source === project)!;
  await assert.rejects(executeSandbox({ ...before, mounts: before.mounts!.map(source => source === missing ? { ...source, ino: -1 } : source) }, project), /mount source changed/);
});
integration('mount source directory descriptors do not leak into sandbox commands', async () => {
  const command = `${JSON.stringify(process.execPath)} -e 'const fs=require("node:fs");for(let fd=3;fd<128;fd++){try{if(fs.fstatSync(fd).isDirectory())process.exit(7)}catch{}}'`;
  const result = await bash(command);
  assert.equal(result.exitCode, 0, result.output);
});
