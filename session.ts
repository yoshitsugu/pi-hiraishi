import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { within, type Config, type NetworkMode } from './policy.ts';
import type { FileRequest, Request, Response } from './protocol.ts';

const root = dirname(fileURLToPath(import.meta.url));
interface Pending { resolve: (message: Extract<Response, {type: 'result'}>) => void; reject: (error: Error) => void; onData?: (data: Buffer) => void; cleanup: () => void }
export class SandboxSession {
  private runner?: ChildProcess;
  private pending = new Map<number, Pending>();
  private processes = new Map<number, number>();
  private directory?: string;
  private generation = 0;
  private nextId = 0;
  private state: 'stopped' | 'changing' | 'ready' | 'failed' = 'stopped';
  private failure = 'Sandbox is not started';
  private transition?: Promise<void>;
  private stopping?: Promise<void>;
  private stopRequested = false;
  private cancelLaunch?: () => void;
  private cleanupFailure?: Error;
  mode: NetworkMode = 'off';
  readonly cwd: string; readonly configPath: string; readonly config: Config; readonly agentDir: string; readonly delegated: boolean;
  constructor(cwd: string, configPath: string, config: Config, agentDir = join(homedir(), '.pi/agent'), delegated = false) {
    this.cwd = cwd; this.configPath = configPath; this.config = config; this.agentDir = agentDir; this.delegated = delegated;
  }
  get status() { return this.state; }
  get failureReason() { return this.failure; }
  get epoch() { return this.generation; }
  assertEpoch(epoch: number) { if (this.generation !== epoch) throw new Error('Sandbox session changed; retry the whole operation'); }
  private fail(error: Error) {
    this.failure = error.message;
    if (this.state !== 'changing') this.state = 'failed';
    for (const p of this.pending.values()) { p.cleanup(); p.reject(error); }
    this.pending.clear();
  }
  start(mode = this.config.networkMode): Promise<void> {
    if (this.state !== 'stopped' || this.stopping) return Promise.reject(new Error('A Hiraishi session is already active'));
    this.stopRequested = false;
    return this.transitionTo(mode, false);
  }
  changeMode(mode: NetworkMode): Promise<void> {
    if (this.state !== 'ready') return Promise.reject(new Error(this.state === 'changing' ? 'Sandbox permissions are changing; retry later' : this.failure));
    ++this.generation;
    this.state = 'changing';
    this.fail(new Error('Sandbox permissions changed; retry the operation'));
    return this.transitionTo(mode, true);
  }
  private assertHealthy() { if (this.state === 'failed') throw new Error(this.failure); }
  private transitionTo(mode: NetworkMode, replace: boolean): Promise<void> {
    this.state = 'changing';
    const task = (async () => {
      try {
        if (replace) await this.disposeRunner();
        if (this.stopRequested) throw new Error('Sandbox session ended');
        this.assertHealthy();
        await this.launch(mode);
        if (this.stopRequested) throw new Error('Sandbox session ended');
        this.assertHealthy();
        this.mode = mode; this.state = 'ready';
      } catch (error) { return this.failedTransition(error); }
    })();
    this.transition = task;
    const clear = () => { if (this.transition === task) this.transition = undefined; };
    void task.then(clear, clear);
    return task;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopRequested = true;
    this.state = 'changing';
    ++this.generation; this.fail(new Error('Sandbox session ended'));
    this.cancelLaunch?.();
    const prior = this.transition;
    const task = (async () => {
      // A failed transition performs its own cleanup; stopping still has to verify that nothing remains.
      if (prior) await prior.catch(() => {});
      try { await this.disposeRunner(); this.state = 'stopped'; }
      catch (error) { this.state = 'failed'; this.failure = String((error as Error).message); throw error; }
    })();
    this.stopping = task;
    const clear = () => { if (this.stopping === task) this.stopping = undefined; };
    void task.then(clear, clear);
    return task;
  }
  private async failedTransition(error: unknown): Promise<never> {
    this.state = 'failed'; this.failure = String((error as Error).message);
    try { await this.disposeRunner(); }
    catch (cleanup) { this.failure += `; cleanup failed: ${(cleanup as Error).message}`; }
    throw new Error(this.failure);
  }
  private fatal(error: Error) {
    this.state = 'failed'; this.fail(error);
    if (!this.transition && !this.stopping) {
      void this.stop().then(() => { this.state = 'failed'; this.failure = error.message; }, cleanup => {
        this.state = 'failed'; this.failure = `${error.message}; cleanup failed: ${cleanup.message}`;
      });
    }
  }
  private async launch(mode: NetworkMode) {
    this.directory = mkdtempSync(join(tmpdir(), 'hiraishi-'));
    const temp = join(this.directory, 'work'); const home = join(this.directory, 'home'); const runtime = join(this.directory, 'runtime');
    for (const p of [temp, home, runtime]) mkdirSync(p, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: [...new Set([dirname(process.execPath), '/usr/bin', '/bin', ...(process.env.PATH ?? '').split(':').filter(isAbsolute)])].filter(p => {
        try { const path = realpathSync(p); return ![this.cwd, ...this.config.readWrite].some(root => within(path, realpathSync(root))); } catch { return false; }
      }).join(':'),
      HOME: homedir(), TMPDIR: runtime, CLAUDE_CODE_TMPDIR: temp, LANG: 'C.UTF-8', TERM: 'xterm-256color',
    };
    const child = fork(join(root, 'runner.ts'), [], { cwd: this.cwd, env, execArgv: [], detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.runner = child;
    let diagnostic = '';
    child.stderr!.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-2000); });
    child.stdout!.resume();
    const generation = this.generation;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('SRT initialization timed out')), 20000);
      const cancel = () => finish(new Error('Sandbox session ended'));
      this.cancelLaunch = cancel;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (this.cancelLaunch === cancel) this.cancelLaunch = undefined;
        error ? reject(error) : resolve();
      };
      child.once('error', error => { this.fail(error); finish(error); });
      child.once('exit', (code, signal) => {
        let error = new Error(`Sandbox runner exited (${signal ?? code}): ${diagnostic}`);
        try { this.killToolProcesses(); }
        catch (cleanup) { error = new Error(`${error.message}; cleanup failed: ${(cleanup as Error).message}`); this.cleanupFailure = error; }
        if (this.runner === child && this.state === 'ready') this.fatal(error);
        finish(error);
      });
      child.on('message', raw => {
        if (this.runner !== child) return;
        const message = raw as Response;
        if (message.type === 'spawned') { this.processes.set(message.id, message.pid); return; }
        if (message.type === 'reaped') { this.processes.delete(message.id); return; }
        if (message.type === 'fatal') { const error = new Error(message.error); this.fatal(error); finish(error); return; }
        if (message.type === 'ready') { finish(); return; }
        if (generation !== this.generation) return;
        const p = this.pending.get(message.id);
        if (!p) return;
        if (message.type === 'data') p.onData?.(Buffer.from(message.data, 'base64'));
        else { this.pending.delete(message.id); p.cleanup(); message.error ? p.reject(new Error(message.error)) : p.resolve(message); }
      });
      child.send({ cwd: realpathSync(this.cwd), configPath: this.configPath, config: this.config, mode, runtimeRoot: root, temp, home, agentDir: this.agentDir, delegated: this.delegated });
    });
  }
  private killToolProcesses() {
    const failures: string[] = [];
    for (const [id, pid] of this.processes) {
      try { process.kill(-pid, 'SIGKILL'); this.processes.delete(id); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') this.processes.delete(id); else failures.push(String(e)); }
    }
    if (failures.length) throw new Error(failures.join('; '));
  }
  private async disposeRunner() {
    const child = this.runner;
    this.cleanupFailure = undefined;
    try { this.killToolProcesses(); } catch (error) { this.cleanupFailure = error as Error; }
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        if (child.connected) child.send({ id: ++this.nextId, op: 'shutdown' }, () => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Sandbox shutdown timed out')), 5000); })]);
        } finally {
          if (timer) clearTimeout(timer);
          if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
        }
      }
      // SRT's host-side relay children belong to the runner's process group.
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
      if (this.cleanupFailure) throw this.cleanupFailure;
      this.runner = undefined;
    }
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.directory) { rmSync(this.directory, { recursive: true, force: true }); this.directory = undefined; }
  }
  request(request: Omit<Extract<Request, {op: 'bash'}>, 'id'> | FileRequest, options: { signal?: AbortSignal; onData?: (data: Buffer) => void } = {}) {
    if (this.state !== 'ready') return Promise.reject(new Error(this.state === 'changing' ? 'Sandbox permissions are changing; retry later' : this.failure));
    if (options.signal?.aborted) return Promise.reject(new Error('Tool execution cancelled'));
    if (request.op === 'bash' && request.timeout !== undefined && (!Number.isFinite(request.timeout) || request.timeout <= 0 || request.timeout > 3600)) return Promise.reject(new Error('Invalid timeout'));
    const id = ++this.nextId; const child = this.runner!;
    return new Promise<Extract<Response, {type: 'result'}>>((resolve, reject) => {
      const cancel = () => { if (child.connected) child.send({ id: ++this.nextId, op: 'cancel', target: id }, () => {}); };
      const cleanup = () => options.signal?.removeEventListener('abort', cancel);
      options.signal?.addEventListener('abort', cancel, { once: true });
      this.pending.set(id, { resolve, reject, onData: options.onData, cleanup });
      child.send({ ...request, id }, error => { if (error) { this.pending.delete(id); cleanup(); reject(error); } });
    });
  }
}
