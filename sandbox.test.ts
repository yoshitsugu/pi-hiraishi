import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { validateConfig } from './policy.ts';
import { SandboxSession } from './session.ts';
import { createOperations } from './tools.ts';

const socatPath = process.env.HIRAISHI_TEST_SOCAT;
const dependencyErrors = SandboxManager.checkDependencies().errors.filter(e => !(socatPath && e === 'socat not installed'));
const probe = spawnSync('/usr/bin/bwrap', ['--unshare-user','--unshare-pid','--ro-bind','/','/','--','/bin/true'], { encoding: 'utf8' });
const unavailable = dependencyErrors.length ? dependencyErrors.join('; ') : probe.status !== 0 ? probe.stderr || String(probe.error) : '';
if (unavailable && process.env.HIRAISHI_REQUIRE_SANDBOX === '1') throw new Error(unavailable);
const integration = (name: string, fn: () => Promise<void>) => test(name, { skip: unavailable || false }, fn);
async function fixture(config = {}) {
  const root = mkdtempSync('/tmp/hiraishi-test-');
  for (const d of ['project','outside','read-only','extra-write']) mkdirSync(`${root}/${d}`);
  writeFileSync(`${root}/outside/secret`, 'outside fixture');
  writeFileSync(`${root}/read-only/sample`, 'reference');
  symlinkSync(`${root}/outside`, `${root}/project/link`);
  const session = new SandboxSession(`${root}/project`, `${root}/config.json`, validateConfig({ ...(socatPath ? { socatPath } : {}), ...config }));
  try { await session.start(); } catch (e) { rmSync(root,{recursive:true,force:true}); throw e; }
  return { root, session, cleanup: async () => { await session.stop(); rmSync(root,{recursive:true,force:true}); } };
}
integration('SRT confines read/write/edit/bash, child processes, secrets, and shared temporary files', async () => {
  const previousSecret = process.env.HIRAISHI_FIXTURE_SECRET; process.env.HIRAISHI_FIXTURE_SECRET = 'synthetic-only';
  const f = await fixture();
  const shared = mkdtempSync('/tmp/hiraishi-shared-'); writeFileSync(`${shared}/secret`,'host temporary secret');
  try {
    const op = createOperations(f.session);
    await op.write.mkdir(`${f.root}/project/src`);
    await op.write.writeFile(`${f.root}/project/src/a`,'original');
    await op.edit.access(`${f.root}/project/src/a`);
    await op.edit.writeFile(`${f.root}/project/src/a`,'edited');
    assert.equal((await op.read.readFile(`${f.root}/project/src/a`)).toString(),'edited');
    for (const path of [`${f.root}/outside/secret`,`${f.root}/project/link/secret`,`${shared}/secret`]) {
      await assert.rejects(op.read.readFile(path));
      await assert.rejects(op.write.writeFile(path,'overwrite'));
      await assert.rejects(op.edit.access(path));
    }
    let output='';
    const r = await op.bash.exec(`test -z "$HIRAISHI_FIXTURE_SECRET" && printf ok > output && /bin/sh -c 'cat output'`,f.session.cwd,{onData:d=>{output+=d},timeout:5});
    assert.equal(r.exitCode,0,output); assert.equal(output,'ok');
    let temp=''; await op.bash.exec('printf "%s" "$TMPDIR"', f.session.cwd,{onData:d=>{temp+=d},timeout:5});
    assert.match(temp,/\/hiraishi-.*\/work$/);
    assert.equal(readFileSync(`${f.root}/outside/secret`,'utf8'),'outside fixture');
  } finally { await f.cleanup();rmSync(shared,{recursive:true,force:true});if(previousSecret===undefined)delete process.env.HIRAISHI_FIXTURE_SECRET;else process.env.HIRAISHI_FIXTURE_SECRET=previousSecret; }
});
integration('mode changes reject in-flight calls and stale multi-step edit operations', async () => {
  const f=await fixture();
  try {
    const old = createOperations(f.session);
    let resolveStarted!:()=>void; const started = new Promise<void>(r=>{resolveStarted=r});
    const running = f.session.request({op:'bash',command:'printf started; sleep 30',timeout:35},{onData:()=>resolveStarted()});
    const rejected = assert.rejects(running,/changed/);
    await started;
    const changing = f.session.changeMode('http-get');
    await assert.rejects(f.session.request({op:'read',path:`${f.root}/project/a`}),/changing/);
    await assert.rejects(f.session.changeMode('http-all'),/changing/);
    await changing; await rejected;
    assert.equal(f.session.mode,'http-get');
    await assert.rejects(old.write.writeFile(`${f.root}/project/a`,'stale'),/changed/);
    assert(!existsSync(`${f.root}/project/a`));
    await createOperations(f.session).write.writeFile(`${f.root}/project/a`,'fresh');
    await assert.rejects(f.session.start(),/already active/);
    await f.session.changeMode('off');
    assert.equal((await createOperations(f.session).read.readFile(`${f.root}/project/a`)).toString(),'fresh');
  } finally {await f.cleanup();}
});
integration('cancellation and timeout stop commands without a host fallback', async () => {
  const f=await fixture();
  try {
    const signal = new AbortController(); let resolveStarted!:()=>void;const started=new Promise<void>(r=>{resolveStarted=r});
    const work=f.session.request({op:'bash',command:'printf started; sleep 20; touch cancelled',timeout:25},{signal:signal.signal,onData:()=>resolveStarted()});
    const failed=assert.rejects(work,/cancelled/);await started;signal.abort();await failed;
    await assert.rejects(f.session.request({op:'bash',command:'sleep 20; touch timeout',timeout:0.1}),/timed out/);
    assert(!existsSync(`${f.root}/project/cancelled`)); assert(!existsSync(`${f.root}/project/timeout`));
  } finally {await f.cleanup();}
});
integration('direct TCP, Unix sockets, and proxy connections to internal services are refused', async () => {
  const server=createServer(socket=>socket.end('host service'));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as {port:number}).port;
  const f=await fixture();
  try {
    await f.session.changeMode('http-all');
    const op=createOperations(f.session);
    let text='';const r=await op.bash.exec(`curl --noproxy '*' -sS --max-time 2 http://127.0.0.1:${port}`,f.session.cwd,{onData:d=>{text+=d},timeout:5});
    assert.notEqual(r.exitCode,0,text);
    text='';await op.bash.exec(`curl --noproxy '' -sS -w '%{http_code}' --max-time 2 http://127.0.0.1:${port}`,f.session.cwd,{onData:d=>{text+=d},timeout:5});
    assert.match(text,/403|refused|blocked/i);
    text='';const unix=await op.bash.exec(`${process.execPath} -e 'require("node:net").connect("/tmp/host.sock").on("error",e=>{console.log(e.code);process.exit(1)})'`,f.session.cwd,{onData:d=>{text+=d},timeout:5});
    assert.notEqual(unix.exitCode,0,text);
  }finally{await f.cleanup();server.close();await once(server,'close');}
});
integration('initialization failure refuses tools and does not restore local adapters', async () => {
  const root=mkdtempSync('/tmp/hiraishi-invalid-');mkdirSync(`${root}/project`);
  const s=new SandboxSession(`${root}/project`,`${root}/config`,validateConfig({socatPath:`${root}/missing-socat`}));
  try {await assert.rejects(s.start());assert.equal(s.status,'failed');await assert.rejects(s.request({op:'bash',command:'touch bypass'}));assert(!existsSync(`${root}/project/bypass`));}
  finally{await s.stop();rmSync(root,{recursive:true,force:true});}
});
integration('SRT enforces methods on local HTTP and TLS-terminated HTTPS including keep-alive', async () => {
  const root=mkdtempSync('/tmp/hiraishi-network-');
  try {
    const cert=spawnSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${root}/server.key`,'-out',`${root}/server.crt`,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{encoding:'utf8'});
    assert.equal(cert.status,0,cert.stderr);
    const {spawn}=await import('node:child_process');
    const child=spawn(process.execPath,['fixtures/network.mjs',root],{env:{PATH:process.env.PATH,HOME:process.env.HOME,HIRAISHI_TEST_SOCAT:socatPath,TMPDIR:root,NODE_EXTRA_CA_CERTS:`${root}/server.crt`},detached:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    const timer=setTimeout(()=>process.kill(-child.pid!,'SIGKILL'),15000);
    try{const [code]=await once(child,'close');assert.equal(code,0,output);assert.match(output,/checks passed/);}finally{clearTimeout(timer);try{process.kill(-child.pid!,'SIGKILL')}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
  }finally{rmSync(root,{recursive:true,force:true});}
});
integration('explicit read grants, write grants, credential denies, and SRT private keys retain their boundaries', async () => {
  const f=await fixture();
  try {
    await f.session.stop();
    writeFileSync(`${f.root}/project/secret`,'synthetic project credential');
    const next=new SandboxSession(f.session.cwd,`${f.root}/config`,validateConfig({...(socatPath?{socatPath}:{}),readOnly:[`${f.root}/read-only`],readWrite:[`${f.root}/extra-write`],denyRead:[`${f.root}/project/secret`]}));
    try {
      await next.start('http-get');const op=createOperations(next);
      assert.equal((await op.read.readFile(`${f.root}/read-only/sample`)).toString(),'reference');
      await assert.rejects(op.write.writeFile(`${f.root}/read-only/sample`,'overwrite'));
      await op.write.writeFile(`${f.root}/extra-write/cache`,'cache');
      assert.equal(readFileSync(`${f.root}/extra-write/cache`,'utf8'),'cache');
      try{assert.equal((await op.read.readFile(`${f.root}/project/secret`)).length,0);}catch(e){assert.match(String(e),/EACCES|ENOENT|EPERM/);}
      const {readdirSync}=await import('node:fs');
      const runtime=`${(next as any).directory}/runtime`;
      const keys=readdirSync(runtime).map(name=>`${runtime}/${name}/ca.key`).filter(existsSync);
      assert(keys.length>0);
      for(const path of keys) {
        try{assert.equal((await op.read.readFile(path)).length,0);}catch(e){assert.match(String(e),/EACCES|ENOENT|EPERM/);}
      }
    }finally{await next.stop();}
  }finally{await f.cleanup();}
});
integration('pi adapters execute through SRT, refuse replacements, and reset permissions on session navigation', async () => {
  const root=mkdtempSync('/tmp/hiraishi-adapter-');mkdirSync(`${root}/project`);
  const old=process.env.HIRAISHI_CONFIG;process.env.HIRAISHI_CONFIG=`${root}/config`;
  writeFileSync(`${root}/config`,JSON.stringify({...(socatPath?{socatPath}:{}),networkMode:'off'}));
  const {default:extension}=await import('./hiraishi.ts');
  const handlers=new Map<string,any>(),tools=new Map<string,any>(),commands=new Map<string,any>();const statuses:string[]=[];const notices:string[]=[];
  const pi={on:(name:string,fn:unknown)=>handlers.set(name,fn),registerTool:(t:any)=>tools.set(t.name,{...t,sourceInfo:{source:'extension',path:new URL('./hiraishi.ts',import.meta.url).pathname}}),getAllTools:()=>[...tools.values()],registerCommand:(name:string,c:any)=>commands.set(name,c)};
  const ctx:any={cwd:`${root}/project`,ui:{setStatus:(_key:string,text:string)=>statuses.push(text),notify:(text:string)=>notices.push(text)}};
  try {
    extension(pi as any);await handlers.get('session_start')({},ctx);
    assert(statuses.at(-1)?.includes('off'),notices.join('\n'));
    assert.equal(handlers.get('tool_call')({toolName:'write'},ctx),undefined);
    assert(handlers.get('tool_call')({toolName:'external-custom'},ctx).block);
    await tools.get('write').execute('w',{path:'sample',content:'through SRT'},undefined,undefined,ctx);
    assert.equal(readFileSync(`${root}/project/sample`,'utf8'),'through SRT');
    await commands.get('hiraishi-network').handler('http-get',ctx);assert(statuses.at(-1)?.includes('http-get'),notices.join('\n'));
    const original=tools.get('read');tools.set('read',{...original,parameters:{...original.parameters}});
    assert(handlers.get('tool_call')({toolName:'read'},ctx).block);
    await assert.rejects(original.execute('r',{path:'sample'},undefined,undefined,ctx),/replaced/);
    tools.set('read',original);
    await handlers.get('session_before_tree')({},ctx);
    assert(handlers.get('tool_call')({toolName:'read'},ctx).block);
    await handlers.get('session_tree')({},ctx);assert(statuses.at(-1)?.includes('off'),notices.join('\n'));
    const changing=commands.get('hiraishi-network').handler('http-all',ctx);
    const stopping=handlers.get('session_before_switch')({},ctx);
    const restarting=handlers.get('session_start')({},ctx);
    await Promise.all([changing,stopping,restarting]);
    assert(statuses.at(-1)?.includes('off'),notices.join('\n'));
    assert(!notices.some(s=>s.includes('already active')),notices.join('\n'));
    const starting=handlers.get('session_start')({},ctx);
    await handlers.get('session_shutdown')();await starting;
    assert(handlers.get('tool_call')({toolName:'read'},ctx).block);
    await handlers.get('session_start')({},ctx);
    let out='';const shell=handlers.get('user_bash')({},ctx);
    const result=await shell.operations.exec('cat sample',ctx.cwd,{onData:(data:Buffer)=>{out+=data},timeout:5});assert.equal(result.exitCode,0,out);assert.equal(out,'through SRT');
  }finally{await handlers.get('session_shutdown')?.();if(old===undefined)delete process.env.HIRAISHI_CONFIG;else process.env.HIRAISHI_CONFIG=old;rmSync(root,{recursive:true,force:true});}
});
integration('runner failures reject pending operations, including failures during a permission transition', async () => {
  const f=await fixture();
  try {
    let mark!:()=>void;const started=new Promise<void>(resolve=>{mark=resolve});
    const work=f.session.request({op:'bash',command:'printf running; sleep 30',timeout:35},{onData:()=>mark()});
    const rejected=assert.rejects(work,/runner exited/);
    await started;(f.session as any).runner.kill('SIGKILL');await rejected;
    assert.equal(f.session.status,'failed');
    await assert.rejects(f.session.request({op:'bash',command:'touch bypass'}));
    assert(!existsSync(`${f.root}/project/bypass`));
  }finally{await f.cleanup();}
  const g=await fixture();
  try {
    const old=(g.session as any).runner;
    const change=g.session.changeMode('http-all');
    old.emit('message',{type:'fatal',error:'synthetic cleanup failure'});
    await assert.rejects(change);
    assert.equal(g.session.status,'failed');
    await assert.rejects(g.session.request({op:'bash',command:'touch bypass'}));
    assert(!existsSync(`${g.root}/project/bypass`));
  }finally{await g.cleanup();}
});

integration('stop takes priority over startup and mode changes and coalesces concurrent stops', async () => {
  const root=mkdtempSync('/tmp/hiraishi-stop-');mkdirSync(`${root}/project`);
  const s=new SandboxSession(`${root}/project`,`${root}/config`,validateConfig(socatPath?{socatPath}:{}));
  try {
    const starting=s.start();const failed=assert.rejects(starting,/ended/);
    const stopping=s.stop();assert.equal(s.stop(),stopping);
    await Promise.all([failed,stopping]);assert.equal(s.status,'stopped');assert.equal((s as any).runner,undefined);
    await s.start();
    const changing=s.changeMode('http-all');const interrupted=assert.rejects(changing,/ended/);
    await s.stop();await interrupted;
    assert.equal(s.status,'stopped');assert.equal((s as any).runner,undefined);
    await assert.rejects(s.request({op:'bash',command:'touch bypass'}));
    await s.start();assert.equal(s.mode,'off');
  } finally {await s.stop();rmSync(root,{recursive:true,force:true});}
});

integration('a writable ancestor of host TMPDIR is rejected before SRT starts', async () => {
  const root=mkdtempSync('/tmp/hiraishi-runtime-boundary-');
  for(const d of ['project','cache','cache/tmp'])mkdirSync(`${root}/${d}`);
  const previous=process.env.TMPDIR;process.env.TMPDIR=`${root}/cache/tmp`;
  const s=new SandboxSession(`${root}/project`,`${root}/config`,validateConfig({...(socatPath?{socatPath}:{}),readWrite:[`${root}/cache`]}));
  try {await assert.rejects(s.start(),/private SRT/);assert.equal((s as any).runner,undefined);assert.equal((s as any).directory,undefined);}
  finally {await s.stop();if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;rmSync(root,{recursive:true,force:true});}
});

integration('fatal stops the runner and remaining commands instead of only rejecting pending calls', async () => {
  const f=await fixture();
  try {
    let mark!:()=>void;const started=new Promise<void>(resolve=>{mark=resolve});
    const work=f.session.request({op:'bash',command:'printf running; sleep 30; touch bypass',timeout:35},{onData:()=>mark()});
    const failed=assert.rejects(work,/synthetic fatal/);await started;
    const runner=(f.session as any).runner;const exited=once(runner,'exit');
    runner.emit('message',{type:'fatal',error:'synthetic fatal'});
    await failed;await exited;await (f.session as any).stopping;
    assert.equal(f.session.status,'failed');assert.equal((f.session as any).runner,undefined);
    assert(!existsSync(`${f.root}/project/bypass`));
  } finally {await f.cleanup();}
});

integration('runner exit records a process cleanup error without throwing from the event listener', async () => {
  const f=await fixture();
  try {
    const session=f.session as any;const kill=session.killToolProcesses.bind(session);let first=true;
    session.killToolProcesses=()=>{if(first){first=false;throw Object.assign(new Error('synthetic EPERM'),{code:'EPERM'});}kill();};
    const runner=session.runner;const exited=once(runner,'exit');runner.kill('SIGKILL');await exited;
    await session.stopping;
    assert.equal(f.session.status,'failed');assert.match(f.session.failureReason,/cleanup failed: synthetic EPERM/);
    assert.equal(session.runner,undefined);
  } finally {await f.cleanup();}
});
