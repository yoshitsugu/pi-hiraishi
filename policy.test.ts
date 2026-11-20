import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { runtimePolicy, allowsHost, hostDecision, validateConfig, parseJsonc, parseGrants, ceilingViolations, ceilingOf, mergeGrants, networkRank, expand, restrictGrants, validateWorkspace } from './policy.ts';

test('configuration rejects legacy classifier settings and malformed grants', () => {
  for (const value of [null, [], { endpoint: 'https://classifier' }, { networkMode: 'all' }, { readOnly: ['relative'] }, { readWrite: ['/'] , unknown: true }, { denyRead: ['/tmp/*'] }, { socatPath: 'socat' }]) assert.throws(() => validateConfig(value));
  assert.deepEqual(validateConfig({}), { networkMode: 'off', maxNetworkMode: 'http-all', readOnly: [], readWrite: [], maxReadOnly: [], maxReadWrite: [], denyRead: [] });
  assert.deepEqual(parseJsonc('{/*comment*/ "url":"http://example.com", // comment\n"value":1}'), { url: 'http://example.com', value: 1 });
});
test('open HTTP sessions refuse literal IPs and localhost before the SRT DNS exemption', () => {
  for (const host of ['localhost','LOCALHOST.','a.localhost','127.0.0.1','127.1','2130706433','0x7f000001','169.254.169.254','[::1]','::ffff:127.0.0.1','[::ffff:169.254.169.254]','1.1.1.1']) assert.equal(allowsHost('http-all', host), false, host);
  assert.equal(allowsHost('http-get', 'example.com'), true);
  assert.equal(allowsHost('off', 'example.com'), false);
  const denied = hostDecision('off', 'example.com');
  const childDenied = hostDecision('off', 'example.com', true);
  assert.notEqual(childDenied, true);
  if (childDenied !== true) {
    assert.match(childDenied.reason, /permissions.networkMode/);
    assert(!childDenied.reason.includes('/hiraishi-network'));
  }
  assert.notEqual(denied, true);
  if (denied !== true) {
    assert.match(denied.reason, /network mode off/);
    assert.match(denied.reason, /pause the affected work/);
    assert.match(denied.reason, /continue offline/);
    assert.match(denied.reason, /Wait for their answer/);
  }
});
test('SRT policy combines method filtering with TLS and opaque tunnel refusal', async () => {
  const root = mkdtempSync('/tmp/hiraishi-policy-');
  for (const d of ['project','session','session/temp','session/home']) mkdirSync(`${root}/${d}`);
  try {
    const input = { cwd: `${root}/project`, temp: `${root}/session/temp`, home: `${root}/session/home`, configPath: `${root}/config`, runtimeRoot: '/opt/hiraishi', srtRoot: '/usr/lib/srt', config: validateConfig({}) };
    for (const mode of ['off', 'http-get', 'http-all'] as const) {
      const p = runtimePolicy({ ...input, mode });
      assert.equal(p.network.refuseOpaqueTunnels, true);
      assert.equal(p.network.requireHostMatch, true);
      assert.deepEqual(p.network.tlsTerminate?.excludeDomains, []);
      assert(p.network.deniedResolvedAddresses?.includes('10.0.0.0/8'));
      for (const method of ['GET','HEAD','POST','PUT','DELETE']) {
        const result = await p.network.filterRequest!(new Request('https://example.com', { method }));
        assert.equal(result.action, mode === 'http-all' || mode === 'http-get' && ['GET','HEAD'].includes(method) ? 'allow' : 'deny');
      }
      assert.equal((await p.network.filterRequest!(new Request('https://example.com', { headers: { Upgrade: 'websocket' } }))).action, 'deny');
    }
    const childPolicy = runtimePolicy({ ...input, mode: 'off', delegated: true });
    const childDenied = await childPolicy.network.filterRequest!(new Request('https://example.com'));
    assert.equal(childDenied.action, 'deny');
    if (childDenied.action === 'deny') {
      assert.match(childDenied.reason ?? '', /permissions.networkMode/);
      assert(!(childDenied.reason ?? '').includes('/hiraishi-network'));
    }
    assert.throws(() => runtimePolicy({ ...input, cwd: '/', mode: 'off' }));
    assert.throws(() => runtimePolicy({ ...input, cwd: '/usr/local', mode: 'off' }));
    assert.throws(() => runtimePolicy({ ...input, config: validateConfig({readOnly:['/tmp']}), mode: 'off' }));
    assert.throws(() => runtimePolicy({ ...input, configPath: `${root}/project/config`, mode: 'off' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('grants cannot expose session internals, HOME, or pi state, including aliases', async () => {
  const { homedir } = await import('node:os');
  const { symlinkSync } = await import('node:fs');
  const root=mkdtempSync('/tmp/hiraishi-policy-boundary-');
  for (const d of ['project','session','session/temp','session/home','agent','agent/skills','host-home']) mkdirSync(`${root}/${d}`);
  symlinkSync(`${root}/session`,`${root}/alias`);
  const previous=process.env.HOME;process.env.HOME=`${root}/host-home`;
  const input={cwd:`${root}/project`,temp:`${root}/session/temp`,home:`${root}/session/home`,configPath:`${root}/config`,runtimeRoot:'/opt/hiraishi',srtRoot:'/usr/lib/srt',agentDir:`${root}/agent`,mode:'off' as const,config:validateConfig({})};
  try {
    for (const path of [root,`${root}/session`,`${root}/session/temp`,`${root}/alias`]) {
      for (const grant of ['readOnly','readWrite']) assert.throws(()=>runtimePolicy({...input,config:validateConfig({[grant]:[path]})}),/private SRT/);
      assert.throws(()=>runtimePolicy({...input,cwd:path}),/private SRT|changed since it was validated/);
    }
    for (const path of [homedir(),`${root}/agent`]) assert.throws(()=>runtimePolicy({...input,config:validateConfig({readOnly:[path]})}),/HOME|pi state/);
    for (const path of [`${root}/agent`,`${root}/agent/skills`]) assert.throws(()=>runtimePolicy({...input,config:validateConfig({readWrite:[path]})}),/pi state/);
    const p=runtimePolicy({...input,config:validateConfig({readOnly:[`${root}/agent/skills`]})});
    assert(p.credentials?.files?.some(f=>f.path===`${root}/agent/models.json`));
    assert(p.credentials?.files?.some(f=>f.path===`${root}/agent/sessions`));
  } finally {if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;rmSync(root,{recursive:true,force:true});}
});

test('HOME grants remain refused when HOME names a symlink', async () => {
  const { symlinkSync } = await import('node:fs');
  const root=mkdtempSync('/tmp/hiraishi-home-alias-');
  for(const d of ['project','host-home','host-home/.ssh','session','session/temp','session/home'])mkdirSync(`${root}/${d}`);
  symlinkSync(`${root}/host-home`,`${root}/home-alias`);
  const previous=process.env.HOME;process.env.HOME=`${root}/home-alias`;
  const input={cwd:`${root}/project`,temp:`${root}/session/temp`,home:`${root}/session/home`,configPath:`${root}/config`,runtimeRoot:'/opt/hiraishi',srtRoot:'/usr',mode:'off' as const,config:validateConfig({})};
  try {
    for(const grant of ['readOnly','readWrite']) for(const path of [`${root}/home-alias`,`${root}/host-home`]) assert.throws(()=>runtimePolicy({...input,config:validateConfig({[grant]:[path]})}),/HOME|pi state/);
    assert.throws(()=>runtimePolicy({...input,cwd:`${root}/host-home`}),/HOME|pi state/);
    const p=runtimePolicy({...input,config:validateConfig({readOnly:[`${root}/home-alias/.ssh`]})});
    assert(p.credentials?.files?.some(f=>f.path===`${root}/host-home/.ssh`));
  } finally {if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;rmSync(root,{recursive:true,force:true});}
});

test('CLI grants add to the baseline, cap at maxNetworkMode, and never shrink denyRead', () => {
  const root = mkdtempSync('/tmp/hiraishi-grants-');
  try {
    mkdirSync(`${root}/docs`); mkdirSync(`${root}/docs/sub`); mkdirSync(`${root}/cache`); mkdirSync(`${root}/project`);
    const baseline = validateConfig({ networkMode: 'off', maxNetworkMode: 'http-get', readOnly: [`${root}/docs`], readWrite: [`${root}/cache`], denyRead: [`${root}/project/.env`] });
    const ceiling = ceilingOf(baseline);
    assert.throws(() => parseGrants('not json'), /not valid JSON/);
    assert.throws(() => parseGrants('[]'), /JSON object/);
    assert.throws(() => parseGrants('{"socatPath":"/usr/bin/socat"}'), /socatPath/);
    assert.throws(() => parseGrants('{"unknown":1}'));
    assert.throws(() => parseGrants('{"readOnly":null}'), /must be an array/);
    assert.throws(() => parseGrants('{"replace":{"denyRead":[]}}'), /replace accepts/);
    assert.deepEqual(parseGrants('{}'), {});
    assert.deepEqual(parseGrants('{"networkMode":"http-get"}'), { networkMode: 'http-get' });

    const within = parseGrants(JSON.stringify({ networkMode: 'http-get', readOnly: [`${root}/docs/sub`], denyRead: [`${root}/project/.secrets`] }));
    assert.deepEqual(ceilingViolations(within, ceiling), []);
    const merged = mergeGrants(baseline, within);
    assert.equal(merged.networkMode, 'http-get');
    assert.equal(merged.maxNetworkMode, 'http-get');
    assert.deepEqual(new Set(merged.readOnly), new Set([`${root}/docs`, `${root}/docs/sub`]));
    assert.deepEqual(merged.readWrite, [`${root}/cache`]);
    assert.deepEqual(new Set(merged.denyRead), new Set([`${root}/project/.env`, `${root}/project/.secrets`]));
    assert.equal(merged.socatPath, baseline.socatPath);

    const empty = mergeGrants(baseline, parseGrants('{"readOnly":[]}'));
    assert.deepEqual(new Set(empty.readOnly), new Set([`${root}/docs`]));

    const exact = mergeGrants(baseline, parseGrants(JSON.stringify({ replace: { readOnly: [`${root}/docs/sub`] } })));
    assert.deepEqual(exact.readOnly, [`${root}/docs/sub`]);
    assert.deepEqual(exact.readWrite, [`${root}/cache`]);

    const wide = parseGrants(JSON.stringify({ networkMode: 'http-all', readOnly: ['/etc'], readWrite: [`${root}/docs`] }));
    const violations = ceilingViolations(wide, ceiling);
    assert.equal(violations.length, 3);
    assert(violations.some(v => v.includes('http-all exceeds the session ceiling http-get')));
    assert(violations.some(v => v.includes('/etc')));
    assert(violations.some(v => v.includes(`${root}/docs`)));
    assert(ceilingViolations(parseGrants(JSON.stringify({ replace: { readOnly: ['/etc'] } })), ceiling).length === 1);
    const crossed = parseGrants(JSON.stringify({ readOnly: [`${root}/cache`] }));
    assert.equal(ceilingViolations(crossed, ceiling).length, 1);
    const home = parseGrants(JSON.stringify({ readOnly: ['~/reference'] }));
    assert.deepEqual(home.readOnly, [expand('~/reference')]);
    assert.equal(ceilingViolations(home, { networkMode: 'off', readOnly: [expand('~/reference')], readWrite: [] }).length, 0);
    assert(networkRank('off') < networkRank('http-get'));
    assert(networkRank('http-get') < networkRank('http-all'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the configuration rejects a startup mode above its ceiling', () => {
  assert.throws(() => validateConfig({ networkMode: 'http-all', maxNetworkMode: 'http-get' }), /cannot exceed/);
  assert.equal(validateConfig({ networkMode: 'http-get', maxNetworkMode: 'http-get' }).maxNetworkMode, 'http-get');
  assert.equal(validateConfig({ networkMode: 'off' }).maxNetworkMode, 'http-all');
});

test('an explicit grant mode caps the session ceiling unless the user approves it', () => {
  const baseline = validateConfig({ networkMode: 'off' });
  assert.equal(mergeGrants(baseline, parseGrants('{"networkMode":"off"}')).maxNetworkMode, 'off');
  assert.equal(mergeGrants(baseline, parseGrants('{"networkMode":"http-get"}')).maxNetworkMode, 'http-get');
  assert.equal(mergeGrants(baseline, parseGrants('{}')).maxNetworkMode, 'http-all');
  assert.equal(mergeGrants(baseline, parseGrants('{"networkMode":"off","maxNetworkMode":"http-get"}')).maxNetworkMode, 'http-get');
  const tight = validateConfig({ maxNetworkMode: 'http-get' });
  assert.equal(ceilingViolations(parseGrants('{"networkMode":"http-all"}'), ceilingOf(tight)).length, 1);
  assert.equal(mergeGrants(tight, parseGrants('{"networkMode":"http-all"}')).maxNetworkMode, 'http-all');
  assert.throws(() => parseGrants('{"readOnly":["/a"],"replace":{"readOnly":["/a"]}}'), /not both/);
});

test('a grant path replaced by a symlink after validation is refused at startup', () => {
  const root = mkdtempSync('/tmp/hiraishi-swap-');
  try {
    for (const d of ['project', 'session/temp', 'session/home', 'cache/sub', 'outside']) mkdirSync(`${root}/${d}`, { recursive: true });
    const input = { cwd: `${root}/project`, temp: `${root}/session/temp`, home: `${root}/session/home`, configPath: `${root}/config`, runtimeRoot: '/opt/hiraishi', srtRoot: '/usr/lib/srt' };
    const config = validateConfig({ readWrite: [`${root}/cache/sub`] });
    assert.equal(config.readWrite[0], `${root}/cache/sub`);
    assert(runtimePolicy({ ...input, mode: 'off', config }).filesystem.allowWrite?.some(entry => (typeof entry === 'string' ? entry : entry.path) === `${root}/cache/sub`));
    rmSync(`${root}/cache/sub`, { recursive: true, force: true });
    symlinkSync(`${root}/outside`, `${root}/cache/sub`);
    assert.throws(() => runtimePolicy({ ...input, mode: 'off', config }), /changed since it was validated/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('starting with the baseline keeps the restrictions the request asked for', () => {
  const root = mkdtempSync('/tmp/hiraishi-baseline-');
  try {
    for (const dir of ['docs', 'docs/sub', 'cache', 'secret']) mkdirSync(`${root}/${dir}`);
    const baseline = validateConfig({ networkMode: 'http-get', maxNetworkMode: 'http-all', readOnly: [`${root}/docs`], readWrite: [`${root}/cache`], hostCommands: [{ name: 'hc', path: '/usr/bin/hc', starts: 'run', operations: [{ name: 'run', argv: ['run', '{hiraishi}', '{grants}'] }] }] });
    const request = parseGrants(JSON.stringify({
      maxNetworkMode: 'off', readOnly: [`${root}/secret`], readWrite: [`${root}/secret`],
      denyRead: [`${root}/docs/secret`], noHostCommands: true,
    }));
    const kept = restrictGrants(baseline, request);
    assert.equal(kept.maxNetworkMode, 'off');
    assert.equal(kept.networkMode, 'off');
    assert.deepEqual(kept.readOnly, [`${root}/docs`]);
    assert.deepEqual(kept.readWrite, [`${root}/cache`]);
    assert(kept.denyRead.includes(`${root}/docs/secret`));
    assert.equal(kept.hostCommands, undefined);
    assert.equal(baseline.hostCommands?.length, 1);
    assert.deepEqual(restrictGrants(baseline, parseGrants(JSON.stringify({ replace: { readOnly: [`${root}/docs/sub`] } }))).readOnly, [`${root}/docs/sub`]);
    const widened = parseGrants(JSON.stringify({ replace: { readOnly: ['/etc'] } }));
    assert.deepEqual(restrictGrants(baseline, widened).readOnly, [`${root}/docs`]);
    assert.deepEqual(restrictGrants(baseline, parseGrants('{}')).readOnly, [`${root}/docs`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('starting with the baseline keeps a replace field that stays inside the ceiling', () => {
  const root = mkdtempSync('/tmp/hiraishi-baseline-partial-');
  try {
    for (const dir of ['docs', 'docs/sub', 'cache', 'cache/sub', 'outside']) mkdirSync(`${root}/${dir}`);
    const baseline = validateConfig({ readOnly: [`${root}/docs`], readWrite: [`${root}/cache`] });
    const readNarrowed = restrictGrants(baseline, parseGrants(JSON.stringify({ replace: { readOnly: [`${root}/docs/sub`], readWrite: [`${root}/outside`] } })));
    assert.deepEqual(readNarrowed.readOnly, [`${root}/docs/sub`]);
    assert.deepEqual(readNarrowed.readWrite, [`${root}/cache`]);
    const writeNarrowed = restrictGrants(baseline, parseGrants(JSON.stringify({ replace: { readOnly: [`${root}/outside`], readWrite: [`${root}/cache/sub`] } })));
    assert.deepEqual(writeNarrowed.readOnly, [`${root}/docs`]);
    assert.deepEqual(writeNarrowed.readWrite, [`${root}/cache/sub`]);
    const both = restrictGrants(baseline, parseGrants(JSON.stringify({ replace: { readOnly: [`${root}/docs/sub`], readWrite: [`${root}/cache/sub`] } })));
    assert.deepEqual(both.readOnly, [`${root}/docs/sub`]);
    assert.deepEqual(both.readWrite, [`${root}/cache/sub`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a grant ceiling clamps the startup mode and must not contradict it', () => {
  const baseline = validateConfig({ networkMode: 'http-get', maxNetworkMode: 'http-all' });
  const capped = mergeGrants(baseline, parseGrants('{"maxNetworkMode":"off"}'));
  assert.equal(capped.networkMode, 'off');
  assert.equal(capped.maxNetworkMode, 'off');
  assert.throws(() => parseGrants('{"networkMode":"http-all","maxNetworkMode":"http-get"}'), /cannot exceed maxNetworkMode/);
  assert.throws(() => parseGrants('{"cwd":"relative"}'), /cwd must be an absolute/);
  assert.throws(() => parseGrants('{"noHostCommands":"yes"}'), /noHostCommands must be a boolean/);
});

test('workspace narrowing requires an existing directory inside the parent workspace', () => {
  const root = mkdtempSync('/tmp/hiraishi-workspace-');
  try {
    for (const dir of ['project', 'project/sub', 'project/other', 'outside']) mkdirSync(`${root}/${dir}`);
    symlinkSync(`${root}/outside`, `${root}/project/escape`);
    symlinkSync(`${root}/project/sub`, `${root}/project/alias`);
    assert.equal(validateWorkspace(`${root}/project/sub`, `${root}/project`), `${root}/project/sub`);
    assert.equal(validateWorkspace(`${root}/project/alias`, `${root}/project`), `${root}/project/sub`);
    assert.equal(validateWorkspace(`${root}/project`, `${root}/project`), `${root}/project`);
    for (const value of [`${root}/outside`, `${root}/project/escape`, `${root}/project/missing`, `${root}/project/other/file`, 'relative', `${root}/project/*`])
      assert.throws(() => validateWorkspace(value, `${root}/project`), /Invalid workspace/);
    assert.throws(() => validateWorkspace(`${root}/project/sub`, `${root}/project/missing`), /outside the parent working directory/);
    assert.throws(() => parseGrants(JSON.stringify({ workspace: `${root}/project/sub` })), /unknown setting workspace/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('delegated sessions can drop host commands and pin their workspace', () => {
  const root = mkdtempSync('/tmp/hiraishi-delegated-');
  try {
    mkdirSync(`${root}/work`);
    const command = { name: 'hc', path: '/usr/bin/hc', starts: 'run', operations: [{ name: 'run', argv: ['run', '{name}', '{cwd}', '{hiraishi}', '{grants}', '{task}'] }] };
    const baseline = validateConfig({ hostCommands: [command] });
    const grants = parseGrants(JSON.stringify({ cwd: `${root}/work`, noHostCommands: true }));
    assert.equal(grants.expectedCwd, `${root}/work`);
    const merged = mergeGrants(baseline, grants);
    assert.equal(merged.hostCommands, undefined);
    assert.deepEqual(mergeGrants(baseline, parseGrants('{}')).hostCommands, baseline.hostCommands);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('host commands are validated and command-line keep-lists name configured commands', () => {
  const command = { name: 'hc', path: '/usr/bin/hc', starts: 'run', operations: [{ name: 'run', argv: ['run', '--name', '{name}', 'pi', '-e', '{hiraishi}', '--hiraishi-grants', '{grants}', '{task}'] }] };
  assert.equal(validateConfig({ hostCommands: [command] }).hostCommands?.[0]?.name, 'hc');
  assert.deepEqual(validateConfig({ hostCommands: [{ ...command, env: ['HOME', 'AUTH_TOKEN'] }] }).hostCommands?.[0]?.env, ['HOME', 'AUTH_TOKEN']);
  for (const value of [
    { hostCommands: {} }, { hostCommands: [{ ...command, name: 'HC' }] }, { hostCommands: [command, command] },
    { hostCommands: [{ ...command, path: 'hc' }] }, { hostCommands: [{ ...command, operations: [] }] },
    { hostCommands: [{ ...command, starts: 'send' }] },
    { hostCommands: [{ ...command, env: 'HOME' }] },
    { hostCommands: [{ ...command, env: ['HOME', 42] }] },
    { hostCommands: [{ ...command, env: ['HOME', '1TOKEN'] }] },
    { hostCommands: [{ ...command, env: ['HOME', 'BAD-NAME'] }] },
    { hostCommands: [{ ...command, env: ['HOME', ''] }] },
    { hostCommands: [{ ...command, operations: [{ name: 'run', argv: ['run', '{shell}'] }] }] },
    { hostCommands: [{ ...command, operations: [{ name: 'run', argv: [] }] }] },
    { hostCommands: [{ ...command, operations: [{ name: 'run', argv: ['run', '--max={timeout}'] }] }] },
    { hostCommands: [{ ...command, operations: [{ name: 'run', argv: ['run', '{name}', '{task}'] }] }] },
  ]) assert.throws(() => validateConfig(value));
  assert.deepEqual(parseGrants(JSON.stringify({ hostCommands: ['hc', 'hc'] })).hostCommands, ['hc']);
  for (const value of [{ hostCommands: 'hc' }, { hostCommands: ['Bad Name'] }, { hostCommands: Array(17).fill('hc') }])
    assert.throws(() => parseGrants(JSON.stringify(value)), /hostCommands must be an array/);
  assert.throws(() => parseGrants(JSON.stringify({ env: ['HOME'] })), /unknown setting env/);
});

test('delegable host commands are explicit and never start another child', () => {
  const command = { name: 'itest', path: '/usr/bin/itest', operations: [{ name: 'run', argv: ['run', '{cwd}', '{task}'] }] };
  assert.equal(validateConfig({ hostCommands: [{ ...command, delegable: true }] }).hostCommands?.[0]?.delegable, true);
  assert.equal(validateConfig({ hostCommands: [{ ...command, delegable: false }] }).hostCommands?.[0]?.delegable, undefined);
  assert.throws(() => validateConfig({ hostCommands: [{ ...command, delegable: 'yes' }] }), /delegable: use a boolean/);
  assert.throws(() => validateConfig({ hostCommands: [{ ...command, starts: 'run', delegable: true, operations: [{ name: 'run', argv: ['run', '{grants}'] }] }] }), /cannot be delegable and start another child/);
  for (const placeholder of ['{hiraishi}', '{grants}'])
    assert.throws(() => validateConfig({ hostCommands: [{ ...command, delegable: true, operations: [{ name: 'run', argv: ['run', placeholder] }] }] }), /delegable and cannot use \{hiraishi\} or \{grants\}/);
});

test('host command keep-lists only narrow and reject unknown or re-delegating commands', () => {
  const itest = { name: 'itest', path: '/usr/bin/itest', delegable: true, operations: [{ name: 'run', argv: ['run', '{cwd}', '{task}'] }] };
  const other = { name: 'other', path: '/usr/bin/other', operations: [{ name: 'run', argv: ['run'] }] };
  const hc = { name: 'hc', path: '/usr/bin/hc', starts: 'run', operations: [{ name: 'run', argv: ['run', '{hiraishi}', '{grants}'] }] };
  const baseline = validateConfig({ hostCommands: [itest, other, hc] });
  const kept = mergeGrants(baseline, parseGrants(JSON.stringify({ noHostCommands: true, hostCommands: ['itest'] })));
  assert.deepEqual(kept.hostCommands?.map(command => command.name), ['itest']);
  assert.deepEqual(mergeGrants(baseline, parseGrants(JSON.stringify({ hostCommands: ['itest'] }))).hostCommands?.map(command => command.name), ['itest']);
  assert.equal(mergeGrants(baseline, parseGrants(JSON.stringify({ noHostCommands: true, hostCommands: [] }))).hostCommands, undefined);
  assert.equal(mergeGrants(baseline, parseGrants(JSON.stringify({ noHostCommands: true }))).hostCommands, undefined);
  assert.deepEqual(mergeGrants(baseline, parseGrants('{}')).hostCommands?.map(command => command.name), ['itest', 'other', 'hc']);
  assert.throws(() => mergeGrants(baseline, parseGrants(JSON.stringify({ hostCommands: ['missing'] }))), /unknown host command missing/);
  assert.throws(() => mergeGrants(baseline, parseGrants(JSON.stringify({ hostCommands: ['hc'] }))), /starts another child and cannot be delegated/);
  assert.throws(() => mergeGrants(validateConfig({ hostCommands: [itest] }), parseGrants(JSON.stringify({ hostCommands: ['other'] }))), /unknown host command other/);
  const restricted = restrictGrants(baseline, parseGrants(JSON.stringify({ noHostCommands: true, hostCommands: ['itest'] })));
  assert.deepEqual(restricted.hostCommands?.map(command => command.name), ['itest']);
});

test('grants are canonicalized so a later symlink swap cannot widen the grant', () => {
  const root = mkdtempSync('/tmp/hiraishi-grants-link-');
  try {
    for (const d of ['docs', 'docs/inner', 'outside']) mkdirSync(`${root}/${d}`);
    symlinkSync(`${root}/docs/inner`, `${root}/docs/link`);
    const baseline = validateConfig({ readOnly: [`${root}/docs`] });
    const grants = parseGrants(JSON.stringify({ readOnly: [`${root}/docs/link`] }));
    assert.deepEqual(ceilingViolations(grants, ceilingOf(baseline)), []);
    assert.deepEqual(mergeGrants(baseline, grants).readOnly, [`${root}/docs`, `${root}/docs/inner`]);
    const escaping = parseGrants(JSON.stringify({ readOnly: [`${root}/outside`] }));
    assert.equal(ceilingViolations(escaping, ceilingOf(baseline)).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('configured path ceilings accept grants without granting them to the session', () => {
  const root = mkdtempSync('/tmp/hiraishi-path-ceiling-');
  try {
    for (const dir of ['project', 'docs', 'secret', 'cache']) mkdirSync(`${root}/${dir}`);
    const baseline = validateConfig({
      readOnly: [`${root}/docs`], maxReadOnly: [`${root}/secret`], maxReadWrite: [`${root}/cache`],
    });
    assert.deepEqual(baseline.maxReadOnly, [`${root}/secret`]);
    assert.deepEqual(baseline.maxReadWrite, [`${root}/cache`]);
    assert.deepEqual(baseline.readOnly, [`${root}/docs`]);
    assert.deepEqual(baseline.readWrite, []);
    assert.throws(() => validateConfig({ maxReadOnly: ['relative'] }));
    assert.throws(() => validateConfig({ maxReadWrite: [`${root}/*`] }));
    assert.throws(() => validateConfig({ maxReadOnly: [42] }));

    const ceiling = ceilingOf(baseline, `${root}/project`);
    assert.deepEqual(ceiling.readOnly, [`${root}/docs`, `${root}/secret`, `${root}/cache`, `${root}/project`]);
    assert.deepEqual(ceiling.readWrite, [`${root}/cache`, `${root}/project`]);

    const inside = parseGrants(JSON.stringify({ readOnly: [`${root}/secret`, `${root}/cache`] }));
    assert.deepEqual(ceilingViolations(inside, ceiling), []);
    const writeCeiling = parseGrants(JSON.stringify({ readWrite: [`${root}/cache`] }));
    assert.deepEqual(ceilingViolations(writeCeiling, ceiling), []);
    assert.equal(ceilingViolations(parseGrants(JSON.stringify({ readWrite: [`${root}/secret`] })), ceiling).length, 1);
    assert.equal(ceilingViolations(parseGrants(JSON.stringify({ readOnly: [`${root}/other`] })), ceiling).length, 1);

    const merged = mergeGrants(baseline, inside);
    assert.deepEqual(merged.maxReadOnly, [`${root}/secret`]);
    assert.deepEqual(merged.maxReadWrite, [`${root}/cache`]);
    assert.deepEqual(merged.readOnly, [`${root}/docs`, `${root}/secret`, `${root}/cache`]);
    assert.deepEqual(merged.readWrite, []);

    const restricted = restrictGrants(baseline, parseGrants(JSON.stringify({ noHostCommands: true })));
    assert.deepEqual(restricted.maxReadOnly, []);
    assert.deepEqual(restricted.maxReadWrite, []);
    assert.deepEqual(restricted.readOnly, [`${root}/docs`]);

    const command = { name: 'hc', path: '/usr/bin/hc', starts: 'run', operations: [{ name: 'run', argv: ['run', '{grants}'] }] };
    const delegated = mergeGrants(validateConfig({ ...baseline, hostCommands: [command] }), parseGrants(JSON.stringify({ noHostCommands: true })));
    assert.equal(delegated.hostCommands, undefined);
    assert.deepEqual(delegated.maxReadOnly, [], 'a delegated child must not inherit its own configuration ceiling');
    assert.deepEqual(delegated.maxReadWrite, []);

    assert.throws(() => parseGrants(JSON.stringify({ maxReadWrite: [`${root}/cache`] })), /configuration-only/);
    assert(restrictGrants(baseline, parseGrants('{}')).maxReadWrite.includes(`${root}/cache`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
