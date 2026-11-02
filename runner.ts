import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { hostDecision, runtimePolicy, NETWORK_DENIAL_GUIDANCE } from './policy.ts';
import type { Request, Response, RunnerInit } from './protocol.ts';

const require = createRequire(import.meta.url);
const srtRoot = dirname(dirname(require.resolve('@anthropic-ai/sandbox-runtime')));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const FILE_WORKER = String.raw`
const fs = require('node:fs/promises');
let chunks=[], size=0;
process.stdin.on('data', chunk => { size += chunk.length; if(size>48*1024*1024) process.exit(1); chunks.push(chunk); });
process.stdin.on('end', async () => {
  try {
    const {op,path,content}=JSON.parse(Buffer.concat(chunks).toString());
    let data;
    if(op==='read'||op==='sample') {
      const handle=await fs.open(path,'r');
      try {
        const parts=[]; let total=0; const limit=op==='sample'?4100:32*1024*1024;
        for(;;) { const b=Buffer.alloc(Math.min(65536,limit+1-total)); const r=await handle.read(b,0,b.length,null); if(!r.bytesRead)break; total+=r.bytesRead; if(total>limit){if(op==='sample'){parts.push(b.subarray(0,r.bytesRead-1));break;}throw Error('File exceeds 32 MiB');} parts.push(b.subarray(0,r.bytesRead)); }
        data=Buffer.concat(parts).toString('base64');
      } finally {await handle.close();}
    } else if(op==='write') {const b=Buffer.from(content,'base64');if(b.length>32*1024*1024)throw Error('File exceeds 32 MiB');await fs.writeFile(path,b);}
    else if(op==='mkdir') await fs.mkdir(path,{recursive:true});
    else if(op==='access-read') await fs.access(path,4);
    else if(op==='access-edit') await fs.access(path,6);
    else throw Error('Unknown operation');
    process.stdout.write(JSON.stringify({data}));
  } catch(e) {process.stderr.write(String(e.message));process.exitCode=1;}
});`;
const active = new Map<number, () => void>();
let init: RunnerInit | undefined;
let policy: SandboxRuntimeConfig;
let closing = false;
let networkDenials = 0;
const work = new Set<Promise<void>>();
const send = (message: Response) => { if (process.connected) process.send!(message); };

async function execute(request: Exclude<Request, { op: 'cancel' | 'shutdown' }>) {
  const state = init!;
  const initialDenials = networkDenials;
  const command = request.op === 'bash' ? request.command : [process.execPath, '--input-type=commonjs', '-e', FILE_WORKER].map(quote).join(' ');
  const environment = `/usr/bin/env HOME=${quote(state.home)} TMPDIR=${quote(state.temp)} `;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let child: ChildProcess | undefined;
  let cancelled = false;
  let wrapped = false;
  const kill = () => {
    cancelled = true;
    controller.abort();
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
  };
  active.set(request.id, kill);
  try {
    const plan = await SandboxManager.wrapWithSandboxArgv(environment + `/bin/bash --noprofile --norc -c ${quote(command)}`, '/bin/bash', { filesystem: policy.filesystem, credentials: policy.credentials }, controller.signal, state.cwd);
    wrapped = true;
    if (closing || cancelled) throw new Error('Tool execution cancelled');
    child = spawn(plan.argv[0]!, plan.argv.slice(1), { cwd: state.cwd, env: plan.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid) send({ type: 'spawned', id: request.id, pid: child.pid });
    const output: Buffer[] = []; let bytes = 0;
    const timeout = request.op === 'bash' ? request.timeout ?? 120 : 30;
    timer = setTimeout(kill, timeout * 1000);
    const onData = (data: Buffer) => {
      if (request.op === 'bash') send({ type: 'data', id: request.id, data: data.toString('base64') });
      else { bytes += data.length; if (bytes > 48 * 1024 * 1024) kill(); else output.push(data); }
    };
    child.stdout!.on('data', onData); child.stderr!.on('data', onData);
    child.stdin!.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') kill(); });
    const code = await new Promise<number>((resolve, reject) => { child!.once('error', reject); child!.once('close', (code, signal) => resolve(code ?? (signal ? 137 : 1)));
      child!.stdin!.end(request.op === 'bash' ? undefined : JSON.stringify({ ...request, content: request.op === 'write' ? request.content : undefined })); });
    if (cancelled) throw new Error('Tool execution cancelled or timed out');
    const text = Buffer.concat(output).toString();
    if (request.op !== 'bash' && code !== 0) throw new Error(text.slice(0, 2000) || 'Sandbox file operation failed');
    const data = request.op === 'bash' ? undefined : (JSON.parse(text) as { data?: string }).data;
    send({ type: 'result', id: request.id, exitCode: code, ...(data ? { data } : {}), networkDenied: networkDenials !== initialDenials });
  } catch (error) { send({ type: 'result', id: request.id, error: String((error as Error).message) + (networkDenials !== initialDenials ? `\n${NETWORK_DENIAL_GUIDANCE}` : ''), networkDenied: networkDenials !== initialDenials }); }
  finally {
    if (timer) clearTimeout(timer);
    // A completed shell can leave descendants behind; never let them retain a namespace or proxy connection.
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') send({ type: 'fatal', error: `Process cleanup failed: ${e}` }); } }
    send({ type: 'reaped', id: request.id });
    active.delete(request.id); if (wrapped) SandboxManager.cleanupAfterCommand();
  }
}
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const kill of active.values()) kill();
  await Promise.all([...work]);
  await SandboxManager.reset();
  if (process.connected) process.disconnect();
}
process.on('disconnect', () => { void shutdown().then(() => process.exit(0), error => { process.stderr.write(String(error)); process.exit(1); }); });
process.on('message', (message: RunnerInit | Request) => {
  if (!init) {
    init = message as RunnerInit;
    void (async () => {
      if (process.platform !== 'linux') throw new Error('Hiraishi requires Linux');
      const dependencies = SandboxManager.checkDependencies();
      const missing = dependencies.errors.filter(e => !(init!.config.socatPath && e === 'socat not installed'));
      if (missing.length || dependencies.warnings.length) throw new Error([...missing, ...dependencies.warnings].join('; '));
      policy = runtimePolicy({ ...init!, srtRoot });
      const filterRequest = policy.network.filterRequest!;
      policy.network.filterRequest = async request => {
        const decision = await filterRequest(request);
        if (decision.action === 'deny') ++networkDenials;
        return decision;
      };
      await SandboxManager.initialize(policy, async ({ host }) => {
        const decision = hostDecision(init!.mode, host);
        if (decision !== true) ++networkDenials;
        return decision;
      }, false);
      // A root read deny also masks SRT's early socket mounts; re-expose only its own relay endpoints.
      const sockets = [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()].filter((p): p is string => !!p);
      policy = { ...policy, credentials: { files: [...(policy.credentials?.files ?? []), { path: SandboxManager.getMitmCA()!.keyPath, mode: 'deny' }] }, filesystem: { ...policy.filesystem, allowRead: [...(policy.filesystem.allowRead ?? []), ...sockets.map(path => ({ path, literal: true as const }))] } };
      if (closing) return;
      send({ type: 'ready' });
    })().catch(error => { send({ type: 'fatal', error: String(error.message) }); void shutdown().finally(() => process.exit(1)); });
    return;
  }
  const request = message as Request;
  if (request.op === 'shutdown') { void shutdown().then(() => process.exit(0), () => process.exit(1)); return; }
  if (request.op === 'cancel') { active.get(request.target)?.(); return; }
  if (closing) { send({ type: 'result', id: request.id, error: 'Runner is stopping' }); return; }
  const task = execute(request); work.add(task); void task.finally(() => work.delete(task));
});
