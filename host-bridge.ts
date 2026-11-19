import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ExtensionAPI, ExtensionToolContext, ToolInfo } from '@earendil-works/pi-coding-agent';
import { canonicalGrants, canonicalPath, ceilingViolations, networkRank, parseGrants, within, type Ceiling, type Config, type Grants, type HostCommand, type HostOperation } from './policy.ts';

export const HOST_TOOL = 'hiraishi_host';

export interface HostScope { ceiling: Ceiling; writable: string[]; denyRead: string[] }
export interface HostExec { (bin: string, args: string[], options: { timeout: number; cwd: string; signal?: AbortSignal }): Promise<{ output: string; failed: boolean; aborted?: boolean }> }
export interface HostOptions {
  hiraishiPath: string;
  scope: (ctx: ExtensionToolContext) => HostScope;
  baseline: () => Config;
  commands: () => HostCommand[];
  exec?: HostExec;
}

type Request = { command: string; operation: string; name?: string; cwd?: string; task?: string; grants?: string; lines?: number; timeoutSeconds?: number };

const namePattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const textLimit = 8000;
const outputLimit = 32000;
const envKeys = ['HOME', 'PATH', 'TERM', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS'];
const parameters = {
  type: 'object', additionalProperties: false, required: ['command', 'operation'], properties: {
    command: { type: 'string', description: 'Configured host command name (hostCommands in the Hiraishi configuration).' },
    operation: { type: 'string', description: 'Configured operation of that command.' },
    name: { type: 'string', description: 'Child name for operations that take {name}: 1-32 of a-z, 0-9, - or _.' },
    cwd: { type: 'string', description: 'Existing directory for {cwd}. It becomes the child workspace and must stay inside this session workspace or its write grants.' },
    task: { type: 'string', maxLength: textLimit, description: 'Text for {task}. It cannot begin with - or @, which the started program could read as an option or file argument.' },
    grants: { type: 'string', description: 'Optional JSON permissions for {grants}, same shape as --hiraishi-grants. They are checked and then tightened against the session ceiling before the child starts.' },
    lines: { type: 'integer', minimum: 0, maximum: 2000, description: 'Value for {lines}.' },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300, description: 'Wall-clock limit for the call; also substitutes {timeout}.' },
  },
};
const result = (status: string, text: string) => ({ content: [{ type: 'text' as const, text }], details: { status } });
const clip = (text: string) => text.length > outputLimit ? text.slice(0, outputLimit) + '\n[Output truncated at 32,000 characters.]' : text;
const unique = (paths: string[]) => [...new Set(paths.map(canonicalPath))];

function request(value: unknown): Request {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host request');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !['command', 'operation', 'name', 'cwd', 'task', 'grants', 'lines', 'timeoutSeconds'].includes(key))) throw new Error('Invalid host request');
  if (typeof p.command !== 'string' || !p.command.trim() || p.command.length > 64) throw new Error('Invalid command name');
  if (typeof p.operation !== 'string' || !p.operation.trim() || p.operation.length > 64) throw new Error('Invalid operation name');
  if (p.name !== undefined && (typeof p.name !== 'string' || !namePattern.test(p.name))) throw new Error('Invalid name: 1-32 of a-z, 0-9, - or _');
  if (p.cwd !== undefined && (typeof p.cwd !== 'string' || !isAbsolute(p.cwd))) throw new Error('Invalid cwd: use an absolute path');
  if (p.task !== undefined && (typeof p.task !== 'string' || !p.task.trim() || p.task.length > textLimit)) throw new Error(`Invalid task: 1-${textLimit} characters required`);
  if (p.grants !== undefined && (typeof p.grants !== 'string' || !p.grants.trim() || p.grants.length > textLimit)) throw new Error('Invalid grants');
  if (p.lines !== undefined && (!Number.isInteger(p.lines) || (p.lines as number) < 0 || (p.lines as number) > 2000)) throw new Error('Invalid lines');
  if (p.timeoutSeconds !== undefined && (!Number.isInteger(p.timeoutSeconds) || (p.timeoutSeconds as number) < 1 || (p.timeoutSeconds as number) > 300)) throw new Error('Invalid timeoutSeconds');
  return p as Request;
}

const defaultExec: HostExec = (bin, args, options) => new Promise(resolve => {
  const env = Object.fromEntries(envKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  execFile(bin, args, { timeout: options.timeout * 1000, cwd: options.cwd, env, signal: options.signal, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({
      output: `${stdout}${stderr}`.trim(),
      failed: !!error && !options.signal?.aborted,
      aborted: !!options.signal?.aborted,
    }));
});

export function installHostBridge(pi: ExtensionAPI, options: HostOptions) {
  const exec = options.exec ?? defaultExec;
  const started = new Map<string, Set<string>>();
  const running = new Set<AbortController>();
  const owns = (info: ToolInfo | undefined) => !!info && info.name === HOST_TOOL &&
    info.parameters === parameters && info.sourceInfo.path === options.hiraishiPath && info.sourceInfo.source !== 'builtin';

  // The child reads its own config baseline, so every delegated grant is intersected with it and rewritten as an exact
  // set. That keeps the child inside this session even when the caller used replace, and it never widens the ceiling.
  const childGrants = (requested: Grants | undefined, scope: HostScope, request: Request) => {
    const baseline = options.baseline();
    const delegate = (name: 'readOnly' | 'readWrite') => {
      const wanted = [...new Set([...(requested?.[name] ?? []), ...(requested?.replace?.[name] ?? [])].map(canonicalPath))];
      for (const path of wanted)
        if (!baseline[name].some(root => within(path, canonicalPath(root))))
          throw new Error(`${name} ${path} is not in the configuration baseline, so a host-launched child cannot hold it; ask the user to add it to the configuration.`);
      return unique([
        ...wanted,
        ...baseline[name].filter(path => scope.ceiling[name].some(root => within(path, canonicalPath(root)))),
      ]);
    };
    const requestedCeiling = requested?.maxNetworkMode ?? requested?.networkMode ?? scope.ceiling.networkMode;
    return JSON.stringify({
      networkMode: requested?.networkMode ?? 'off',
      maxNetworkMode: networkRank(requestedCeiling) <= networkRank(scope.ceiling.networkMode) ? requestedCeiling : scope.ceiling.networkMode,
      replace: { readOnly: delegate('readOnly'), readWrite: delegate('readWrite') },
      denyRead: unique([...baseline.denyRead, ...scope.denyRead, ...(requested?.denyRead ?? [])]),
      cwd: canonicalPath(request.cwd ?? scope.writable[0]!),
      noHostCommands: true,
    });
  };

  const substitute = (template: string[], request: Request, operation: HostOperation, scope: HostScope, timeout: number) => {
    const argv: string[] = [];
    for (const entry of template) {
      const placeholder = entry.match(/^\{([a-z]+)\}$/)?.[1];
      if (!placeholder) { argv.push(entry); continue; }
      switch (placeholder) {
        case 'name':
          if (!request.name) throw new Error(`${operation.name} requires name`);
          argv.push(request.name);
          break;
        case 'cwd': {
          const requested = request.cwd ?? scope.writable[0]!;
          const cwd = canonicalPath(requested);
          let directory = false;
          try { directory = statSync(cwd).isDirectory(); } catch { directory = false; }
          if (!directory || !scope.writable.some(root => within(cwd, canonicalPath(root))))
            throw new Error(`cwd ${requested} is outside this session's writable workspace. A child workspace is writable, so it cannot be a read-only grant.`);
          argv.push(cwd);
          break;
        }
        case 'task':
          if (!request.task?.trim()) throw new Error(`${operation.name} requires task`);
          // A leading - or @ would be parsed by the started program as an option or a file argument.
          if (/^[-@]/.test(request.task.trimStart())) throw new Error('task must not begin with - or @');
          argv.push(request.task);
          break;
        case 'grants': {
          let requested: Grants | undefined;
          if (request.grants) {
            requested = parseGrants(request.grants);
            const violations = ceilingViolations(requested, scope.ceiling);
            if (violations.length) throw new Error(JSON.stringify({ reason: 'Requested child permissions exceed this session ceiling.', violations, nextStep: 'Request only permissions within the ceiling, or ask the user to widen the configuration.' }));
          }
          argv.push(childGrants(requested, scope, request));
          break;
        }
        case 'lines':
          argv.push(String(request.lines ?? 0));
          break;
        case 'timeout':
          argv.push(String(timeout));
          break;
        case 'hiraishi':
          argv.push(options.hiraishiPath);
          break;
        default:
          throw new Error(`Unsupported placeholder {${placeholder}}`);
      }
    }
    return argv;
  };

  const spawn = async (bin: string, argv: string[], timeout: number, cwd: string, signal?: AbortSignal) => {
    if (signal?.aborted) return { output: '', failed: false, aborted: true };
    const controller = new AbortController();
    running.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try { return await exec(bin, argv, { timeout, cwd, signal: controller.signal }); }
    finally { running.delete(controller); signal?.removeEventListener('abort', abort); }
  };

  pi.registerTool({
    name: HOST_TOOL, label: 'Host command', parameters, executionMode: 'sequential',
    description: 'Run a host command that the Hiraishi configuration explicitly allows, with fixed argv templates. Each operation maps typed arguments onto placeholders such as {name}, {cwd} or {grants}; the model cannot choose the binary, add flags or use a shell, and task text cannot start with - or @. Every child grant is rewritten against this session ceiling before the child starts. When nothing is configured this tool reports that no host commands are available.',
    promptGuidelines: ['Use hiraishi_host only for the operations the configuration lists; bash cannot reach host-only tools from inside the sandbox. Pass cwd per task so each child gets its own workspace; it must be writable in this session. Keep grants within the session ceiling. Read results back with the configured read operation.'],
    reachesTools: () => [],
    async execute(_id, input, signal, _onUpdate, ctx) {
      if (!owns(pi.getAllTools().find(tool => tool.name === HOST_TOOL))) throw new Error('Hiraishi host bridge was replaced; execution refused');
      if (signal?.aborted) return result('cancelled', 'Host command cancelled.');
      try {
        const p = request(input);
        const scope = options.scope(ctx);
        const command = options.commands().find(entry => entry.name === p.command);
        if (!command) throw new Error(options.commands().length ? `Unknown host command ${p.command}` : 'No host commands are configured. Add hostCommands to the Hiraishi configuration.');
        const operation = command.operations.find(entry => entry.name === p.operation);
        if (!operation) throw new Error(`Unknown operation ${p.operation} for ${command.name}`);
        const used = new Set(operation.argv.flatMap(entry => entry.match(/\{[a-z]+\}/g) ?? []));
        for (const [placeholder, value] of [['{name}', p.name], ['{cwd}', p.cwd], ['{task}', p.task], ['{grants}', p.grants], ['{lines}', p.lines]] as const)
          if (value !== undefined && !used.has(placeholder)) throw new Error(`${operation.name} does not accept ${placeholder.slice(1, -1)}`);
        const bin = canonicalPath(command.path);
        if (scope.writable.some(root => within(bin, canonicalPath(root)))) throw new Error(`Host command ${command.name} resolves inside a writable grant: ${bin}`);
        const timeout = Math.min(p.timeoutSeconds ?? operation.timeoutSeconds ?? 120, operation.timeoutSeconds ?? 3600);
        const argv = substitute(operation.argv, p, operation, scope, timeout);
        const tracked = started.get(command.name) ?? new Set<string>();
        const usesName = used.has('{name}');
        if (usesName && command.starts && operation.name !== command.starts && (!p.name || !tracked.has(p.name)))
          throw new Error(`Unknown child ${p.name}. This bridge only controls children it started.`);
        if (usesName && command.starts === operation.name && p.name && tracked.has(p.name))
          throw new Error(`A child named ${p.name} already exists for ${command.name}.`);
        const outcome = await spawn(bin, argv, timeout, '/', signal);
        const text = outcome.output || `${command.name} ${operation.name} finished without output.`;
        if (outcome.aborted) return result('cancelled', 'Host command cancelled.');
        if (outcome.failed) return result('failed', clip(text));
        if (usesName && command.starts === operation.name && p.name) {
          tracked.add(p.name);
          started.set(command.name, tracked);
        }
        return result('complete', clip(text));
      } catch (error) { return result('blocked', String((error as Error).message).slice(0, 4000)); }
    },
  });

  const reset = () => {
    started.clear();
    for (const controller of running) controller.abort();
    running.clear();
  };
  return { owns, reset };
}
