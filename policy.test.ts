import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { runtimePolicy, allowsHost, hostDecision, validateConfig, parseJsonc } from './policy.ts';

test('configuration rejects legacy classifier settings and malformed grants', () => {
  for (const value of [null, [], { endpoint: 'https://classifier' }, { networkMode: 'all' }, { readOnly: ['relative'] }, { readWrite: ['/'] , unknown: true }, { denyRead: ['/tmp/*'] }, { socatPath: 'socat' }]) assert.throws(() => validateConfig(value));
  assert.deepEqual(validateConfig({}), { networkMode: 'off', readOnly: [], readWrite: [], denyRead: [] });
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
  for (const d of ['project','session','session/temp','session/home','agent','agent/skills']) mkdirSync(`${root}/${d}`);
  symlinkSync(`${root}/session`,`${root}/alias`);
  const input={cwd:`${root}/project`,temp:`${root}/session/temp`,home:`${root}/session/home`,configPath:`${root}/config`,runtimeRoot:'/opt/hiraishi',srtRoot:'/usr/lib/srt',agentDir:`${root}/agent`,mode:'off' as const,config:validateConfig({})};
  try {
    for (const path of [root,`${root}/session`,`${root}/session/temp`,`${root}/alias`]) {
      for (const grant of ['readOnly','readWrite']) assert.throws(()=>runtimePolicy({...input,config:validateConfig({[grant]:[path]})}),/private SRT/);
      assert.throws(()=>runtimePolicy({...input,cwd:path}),/private SRT/);
    }
    for (const path of [homedir(),'/home',`${root}/agent`]) assert.throws(()=>runtimePolicy({...input,config:validateConfig({readOnly:[path]})}),/HOME|pi state/);
    for (const path of [`${root}/agent`,`${root}/agent/skills`]) assert.throws(()=>runtimePolicy({...input,config:validateConfig({readWrite:[path]})}),/pi state/);
    const p=runtimePolicy({...input,config:validateConfig({readOnly:[`${root}/agent/skills`]})});
    assert(p.credentials?.files?.some(f=>f.path===`${root}/agent/models.json`));
    assert(p.credentials?.files?.some(f=>f.path===`${root}/agent/sessions`));
  } finally { rmSync(root,{recursive:true,force:true}); }
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
