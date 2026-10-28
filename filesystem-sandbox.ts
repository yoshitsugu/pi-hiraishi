import { spawn } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, getAgentDir,
  createLocalBashOperations, type BashOperations, type ExtensionAPI, type ToolInfo, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

export interface FilesystemSandboxConfig { enabled?: boolean; readOnly?: string[]; readWrite?: string[] }
export function validateFilesystemSandbox(value: unknown): FilesystemSandboxConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid filesystemSandbox');
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some(key => !['enabled', 'readOnly', 'readWrite'].includes(key)) ||
      (c.enabled !== undefined && typeof c.enabled !== 'boolean')) throw new Error('Invalid filesystemSandbox');
  for (const key of ['readOnly', 'readWrite']) {
    if (c[key] === undefined) continue;
    if (!Array.isArray(c[key]) || c[key].length > 64 || !c[key].every(path => typeof path === 'string' && path.length <= 4096 &&
        (isAbsolute(path) || path.startsWith('~/')) && !/[\x00-\x1f\x7f]/.test(path))) throw new Error(`Invalid filesystemSandbox.${key}`);
  }
  return c as FilesystemSandboxConfig;
}

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const expand = (path: string) => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
const aliases = (path: string) => [...new Set([resolve(path), realpathSync(path)])];
const runtimeFiles = ['hiraishi.ts', 'filesystem-sandbox.ts', 'sandbox-runner.ts', 'messages.ts'].map(name => fileURLToPath(new URL(name, import.meta.url)));
const piRoots = () => [getAgentDir(), join(homedir(), '.pi/agent'), join(homedir(), '.pi/agents'), join(homedir(), '.pi/shared')];
const systemRoots = ['/usr', '/bin', '/sbin', '/lib', '/lib64'];
const systemFiles = ['/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl', '/etc/pki'];

interface PinnedPath { source: string; dev: number; ino: number }
export type SandboxPins = Map<string, PinnedPath>;
export interface SandboxPlan { executable: string; args: string[]; env: NodeJS.ProcessEnv; mounts?: PinnedPath[] }
export function filesystemSandboxPlan(cwd: string, config: FilesystemSandboxConfig, configPath: string, command: string, args: string[], pins: SandboxPins = new Map()): SandboxPlan {
  validateFilesystemSandbox(config);
  if (process.platform !== 'linux') throw new Error('Hiraishi filesystem sandbox requires Linux and bubblewrap; execution refused');
  const executable = ['/usr/bin/bwrap', '/bin/bwrap'].find(path => existsSync(path));
  if (!executable) throw new Error('Hiraishi filesystem sandbox requires bubblewrap; execution refused');
  const project = realpathSync(cwd);
  if (under(homedir(), project)) throw new Error('Use a project directory below HOME, not HOME or a parent directory');
  const pin = (path: string): PinnedPath => {
    const source = realpathSync(path);
    const { dev, ino } = statSync(source);
    const previous = pins.get(path);
    if (previous && (previous.source !== source || previous.dev !== dev || previous.ino !== ino))
      throw new Error(`Sandbox permission path changed; reload required: ${path}`);
    const current = previous ?? { source, dev, ino };
    pins.set(path, current);
    return current;
  };
  const mounts = new Map<string, boolean>();
  const add = (path: string, writable: boolean, required = false) => {
    const full = expand(path);
    if (!existsSync(full)) { if (required) throw new Error(`Sandbox directory does not exist: ${full}`); return; }
    pin(full);
    for (const alias of aliases(full)) {
      if (required && !statSync(alias).isDirectory()) throw new Error(`Sandbox permission must name a directory: ${full}`);
      if (writable && (under(homedir(), alias) || systemRoots.some(root => under(root, alias) || under(alias, root))))
        throw new Error(`Sandbox writable directory is too broad: ${full}`);
      mounts.set(alias, writable);
    }
  };
  for (const path of [...systemRoots, ...systemFiles, dirname(process.execPath), ...piRoots(), join(homedir(), '.agents/skills')]) add(path, false);
  add('/tmp', true, true);
  add(cwd, true, true);
  for (const path of config.readWrite ?? []) add(path, true, true);
  for (const path of config.readOnly ?? []) add(path, false, true);

  // Trusted policy and executable code must stay immutable even inside a writable project or /tmp.
  const protectedPaths = new Set<string>();
  for (const path of [join(project, '.git/hooks'), join(project, '.git/config')])
    if (existsSync(path) && !under(realpathSync(path), project)) throw new Error('Project Git protection resolves outside the project; execution refused');
  for (const path of [...piRoots(), process.execPath, executable, ...runtimeFiles, join(project, '.git/hooks'), join(project, '.git/config')]) {
    if (existsSync(path)) for (const alias of aliases(path)) protectedPaths.add(alias);
  }
  let policyPath = resolve(configPath);
  while (!existsSync(policyPath) && dirname(policyPath) !== policyPath) policyPath = dirname(policyPath);
  if (existsSync(configPath) || [...mounts].some(([root, writable]) => writable && under(policyPath, root)))
    for (const alias of aliases(policyPath)) protectedPaths.add(alias);
  if ([...mounts].some(([root, writable]) => writable && (existsSync(configPath) ? aliases(configPath) : [resolve(configPath)]).some(path => under(path, root))))
    throw new Error('Sandbox configuration must be stored outside writable directories, including /tmp');
  // Mount writable ancestors too: otherwise renaming a parent can replace a protected mount's original host path.
  for (const path of protectedPaths) {
    for (const [root, writable] of [...mounts]) {
      if (!writable || !under(path, root)) continue;
      let parent = dirname(path);
      while (parent !== root && under(parent, root)) {
        if (!mounts.has(parent)) {
          const inherited = [...mounts].filter(([root]) => under(parent, root)).sort(([a], [b]) => b.length - a.length)[0]?.[1] ?? false;
          add(parent, inherited);
        }
        parent = dirname(parent);
      }
    }
  }
  const argv = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--disable-userns', '--cap-drop', 'ALL', '--tmpfs', '/'];
  const sources: PinnedPath[] = [];
  const bind = (source: string, target: string, writable: boolean) => {
    sources.push(pin(source));
    argv.push(writable ? '--bind-fd' : '--ro-bind-fd', String(sources.length + 2), target);
  };
  for (const [path, writable] of [...mounts].sort(([a], [b]) => a.split(sep).length - b.split(sep).length)) bind(path, path, writable);
  argv.push('--dev', '/dev', '--proc', '/proc');
  if (existsSync(join(project, '.git')) && statSync(join(project, '.git')).isDirectory() && !existsSync(join(project, '.git/hooks')))
    argv.push('--tmpfs', join(project, '.git/hooks'), '--remount-ro', join(project, '.git/hooks'));
  for (const path of [...protectedPaths].sort((a, b) => a.split(sep).length - b.split(sep).length)) bind(path, path, false);
  for (const path of [join(getAgentDir(), 'auth.json'), join(homedir(), '.pi/agent/auth.json'), join(homedir(), '.pi/agents/auth.json')]) {
    if (existsSync(path)) for (const alias of aliases(path)) bind('/dev/null', alias, false);
  }
  const pathEntries = [dirname(process.execPath), ...(process.env.PATH ?? '/usr/bin:/bin').split(':')]
    .filter(path => isAbsolute(path) && [...mounts.keys()].some(root => under(path, root)));
  const env: NodeJS.ProcessEnv = { PATH: [...new Set(pathEntries)].join(':'), HOME: homedir(), TMPDIR: '/tmp', LANG: 'C.UTF-8', TERM: 'xterm-256color' };
  argv.push('--remount-ro', '/', '--chdir', resolve(cwd), '--', command, ...args);
  return { executable, args: argv, env, mounts: sources };
}

const MAX = 32 * 1024 * 1024;
// File arguments travel over stdin; no model-supplied content becomes executable source.
const FILE_WORKER = String.raw`
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
let size = 0, chunks = [];
process.stdin.on('data', b => { size += b.length; if (size > 48*1024*1024) process.exit(1); chunks.push(b); });
process.stdin.on('end', async () => {
  try {
    const { op, path, content } = JSON.parse(Buffer.concat(chunks).toString());
    let data;
    if (op === 'read' || op === 'sample') {
      const handle = await fs.open(path, 'r');
      try {
        const limit = op === 'sample' ? 4100 : 32*1024*1024;
        const parts = []; let size = 0;
        for (;;) {
          const buffer = Buffer.alloc(Math.min(65536, limit+1-size));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          size += bytesRead;
          if (size > limit) { if (op === 'sample') { parts.push(buffer.subarray(0, bytesRead-1)); break; } throw new Error('File exceeds 32 MiB sandbox limit'); }
          parts.push(buffer.subarray(0, bytesRead));
        }
        data = Buffer.concat(parts).toString('base64');
      } finally { await handle.close(); }
    } else if (op === 'write') {
      const buffer = Buffer.from(content, 'base64');
      if (buffer.length > 32*1024*1024) throw new Error('File exceeds 32 MiB sandbox limit');
      await fs.writeFile(path, buffer);
    } else if (op === 'mkdir') await fs.mkdir(path, { recursive: true });
    else if (op === 'access-read') await fs.access(path, constants.R_OK);
    else if (op === 'access-edit') await fs.access(path, constants.R_OK | constants.W_OK);
    else throw new Error('Unknown sandbox file operation');
    process.stdout.write(JSON.stringify({ data }));
  } catch (e) { process.stderr.write(String(e.message).slice(0, 1024)); process.exitCode = 1; }
});`;

export function executeSandbox(plan: SandboxPlan, cwd: string, options: {
  signal?: AbortSignal; timeout?: number; input?: string; onData?: (data: Buffer) => void;
} = {}): Promise<{ exitCode: number; output: Buffer }> {
  if (options.signal?.aborted) return Promise.reject(new Error('Sandbox operation aborted'));
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > 2147483))
    return Promise.reject(new Error('Invalid sandbox timeout'));
  const descriptors: number[] = [];
  try {
    for (const source of plan.mounts ?? []) {
      const fd = openSync(source.source, constants.O_RDONLY | constants.O_NOFOLLOW);
      descriptors.push(fd);
      const { dev, ino } = fstatSync(fd);
      if (dev !== source.dev || ino !== source.ino) throw new Error('Sandbox mount source changed; execution refused');
    }
  } catch (error) { for (const fd of descriptors) closeSync(fd); return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn> & { stdin: NonNullable<ReturnType<typeof spawn>['stdin']>; stdout: NonNullable<ReturnType<typeof spawn>['stdout']>; stderr: NonNullable<ReturnType<typeof spawn>['stderr']> };
    try {
      child = spawn(plan.executable, plan.args, { cwd, env: plan.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', ...descriptors] }) as typeof child;
    } catch (error) { reject(error); return; }
    finally { for (const fd of descriptors) closeSync(fd); }

    const output: Buffer[] = []; let bytes = 0; let failure: Error | undefined;
    const kill = (error: Error) => {
      failure ??= error;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const abort = () => kill(new Error('Sandbox operation aborted'));
    const timer = options.timeout === undefined ? undefined : setTimeout(() => kill(new Error('Sandbox operation timed out')), options.timeout * 1000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const data = (chunk: Buffer) => {
      if (options.onData) options.onData(chunk);
      else { bytes += chunk.length; if (bytes > 48 * 1024 * 1024) kill(new Error('Sandbox output limit exceeded')); else output.push(chunk); }
    };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') kill(error); });
    child.on('error', error => { failure = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ exitCode: code ?? (signal ? 128 : 1), output: Buffer.concat(output) });
    });
    child.stdin.end(options.input ?? '');
  });
}

export function createFilesystemOperations(cwd: string, config: FilesystemSandboxConfig, configPath: string, signal?: AbortSignal, pins: SandboxPins = new Map()) {
  const file = async (op: string, path: string, content?: string): Promise<Buffer> => {
    if (content !== undefined && Buffer.byteLength(content) > MAX) throw new Error('File exceeds 32 MiB sandbox limit');
    const plan = filesystemSandboxPlan(cwd, config, configPath, process.execPath, ['--input-type=commonjs', '-e', FILE_WORKER], pins);
    const result = await executeSandbox(plan, cwd, { signal, timeout: 30, input: JSON.stringify({ op, path, content: content === undefined ? undefined : Buffer.from(content).toString('base64') }) });
    if (result.exitCode !== 0) throw new Error(`Sandbox file operation refused: ${result.output.toString().slice(0, 1500)}`);
    const response = JSON.parse(result.output.toString());
    return response.data ? Buffer.from(response.data, 'base64') : Buffer.alloc(0);
  };
  const readFile = (path: string) => file('read', path);
  const writeFile = async (path: string, content: string) => { await file('write', path, content); };
  const bash: BashOperations = { exec: async (command, commandCwd, options) => {
    const plan = filesystemSandboxPlan(commandCwd, config, configPath, '/bin/bash', ['--noprofile', '--norc', '-c', command], pins);
    const { exitCode } = await executeSandbox(plan, commandCwd, { signal: options.signal, timeout: options.timeout, onData: options.onData });
    return { exitCode };
  } };
  return {
    bash,
    read: { readFile, access: async (path: string) => { await file('access-read', path); }, detectImageMimeType: async (path: string) => {
      const b = await file('sample', path);
      if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
      if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
      if (['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
      if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
      return undefined;
    } },
    write: { writeFile, mkdir: async (path: string) => { await file('mkdir', path); } },
    edit: { readFile, writeFile, access: async (path: string) => { await file('access-edit', path); } },
  };
}

export function installFilesystemSandbox(pi: ExtensionAPI, config: () => FilesystemSandboxConfig, configPath: () => string) {
  let snapshot: FilesystemSandboxConfig;
  let configurationError: unknown;
  try { snapshot = structuredClone(validateFilesystemSandbox(config())); }
  catch (error) { configurationError = error; }
  const settings = () => { if (configurationError) throw configurationError; return snapshot; };
  const policyPath = configPath();
  const pins: SandboxPins = new Map();
  const schemas = new Map<string, object>();
  const definitions = (cwd: string, signal?: AbortSignal) => {
    const operations = settings().enabled === false ? undefined : createFilesystemOperations(cwd, settings(), policyPath, signal, pins);
    return [createReadToolDefinition(cwd, { operations: operations?.read }), createWriteToolDefinition(cwd, { operations: operations?.write }),
      createEditToolDefinition(cwd, { operations: operations?.edit }), createBashToolDefinition(cwd, { operations: operations?.bash, exposeSessionEnvironment: false })];
  };
  const owns = (info: ToolInfo | undefined) => !!info && info.parameters === schemas.get(info.name) &&
    info.sourceInfo.source !== 'builtin' && info.sourceInfo.path === pi.getAllTools().find(tool => tool.name === 'hiraishi_review')?.sourceInfo.path;
  // Keep registration independent of configuration validity so malformed policy never restores native tools.
  const initial: ToolDefinition<any, any, any>[] = [createReadToolDefinition(process.cwd()), createWriteToolDefinition(process.cwd()), createEditToolDefinition(process.cwd()), createBashToolDefinition(process.cwd())];
  for (const definition of initial) {
    const parameters = { ...definition.parameters };
    schemas.set(definition.name, parameters);
    pi.registerTool({ ...definition, parameters, async execute(id, input, signal, onUpdate, ctx) {
      const inventory = pi.getAllTools().find(tool => tool.name === definition.name);
      if (!owns(inventory)) throw new Error('Hiraishi sandbox tool was replaced; execution refused');
      const tool = definitions(ctx.cwd, signal).find(tool => tool.name === definition.name)!;
      return tool.execute(id, input as never, signal, onUpdate as never, ctx);
    } });
  }
  pi.on('user_bash', () => ({ operations: { exec: (command, cwd, options) => {
    const current = settings();
    const operations = current.enabled === false ? createLocalBashOperations() : createFilesystemOperations(cwd, current, policyPath, undefined, pins).bash;
    return operations.exec(command, cwd, options);
  } } }));
  return { owns, enabled: () => settings().enabled !== false };
}
