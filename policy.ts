import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

export type NetworkMode = 'off' | 'http-get' | 'http-all';
export type HostPlaceholder = '{name}' | '{cwd}' | '{task}' | '{grants}' | '{lines}' | '{timeout}' | '{hiraishi}';
export const hostPlaceholders: readonly HostPlaceholder[] = ['{name}', '{cwd}', '{task}', '{grants}', '{lines}', '{timeout}', '{hiraishi}'];
export interface HostOperation { name: string; argv: string[]; timeoutSeconds?: number }
export interface HostCommand { name: string; path: string; starts?: string; env?: string[]; delegable?: boolean; operations: HostOperation[] }
export interface Config {
  networkMode: NetworkMode;
  maxNetworkMode: NetworkMode;
  readOnly: string[];
  readWrite: string[];
  maxReadOnly: string[];
  maxReadWrite: string[];
  denyRead: string[];
  socatPath?: string;
  hostCommands?: HostCommand[];
}
export const isNetworkMode = (value: unknown): value is NetworkMode => ['off', 'http-get', 'http-all'].includes(value as string);
export const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
export const expand = (path: string) => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing or over-long path cannot exist, so resolve its existing parent instead.
    if ((code !== 'ENOENT' && code !== 'ENAMETOOLONG') || dirname(absolute) === absolute) throw error;
    return join(canonicalPath(dirname(absolute)), basename(absolute));
  }
}
const isLiteralAbsolute = (path: string) => path.length <= 4096 && !/[\x00-\x1f\x7f*?[\]{}]/.test(path);
export const isWorkspacePath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && isLiteralAbsolute(value);
// The workspace is both the child cwd and its default read/write root, so it must resolve inside the parent cwd.
export function validateWorkspace(value: unknown, root: string): string {
  if (!isWorkspacePath(value)) throw new Error('Invalid workspace: use a literal absolute path');
  const canonical = canonicalPath(value);
  let directory = false;
  try { directory = statSync(canonical).isDirectory(); } catch { directory = false; }
  if (!directory) throw new Error(`Invalid workspace: not an existing directory: ${value}`);
  if (!within(canonical, canonicalPath(root))) throw new Error(`Invalid workspace: ${value} is outside the parent working directory`);
  return canonical;
}
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const literal = (path: string) => ({ path, literal: true as const });

export function parseJsonc(text: string): unknown {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g, match => match.startsWith('/') ? ' ' : match));
}
export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Hiraishi configuration');
  const c = value as Record<string, unknown>;
  const unknown = Object.keys(c).filter(k => !['networkMode', 'maxNetworkMode', 'readOnly', 'readWrite', 'maxReadOnly', 'maxReadWrite', 'denyRead', 'socatPath', 'hostCommands'].includes(k));
  if (unknown.length) throw new Error(`Invalid Hiraishi configuration: unknown setting ${unknown.join(', ')} (old classifier settings are no longer supported)`);
  if (c.networkMode !== undefined && !isNetworkMode(c.networkMode) || c.maxNetworkMode !== undefined && !isNetworkMode(c.maxNetworkMode))
    throw new Error('Invalid Hiraishi configuration: networkMode and maxNetworkMode take off, http-get or http-all');
  const result: Config = { networkMode: c.networkMode as NetworkMode ?? 'off', maxNetworkMode: c.maxNetworkMode as NetworkMode ?? 'http-all', readOnly: [], readWrite: [], maxReadOnly: [], maxReadWrite: [], denyRead: [] };
  if (networkRank(result.networkMode) > networkRank(result.maxNetworkMode)) throw new Error('Invalid Hiraishi configuration: networkMode cannot exceed maxNetworkMode');
  for (const name of ['readOnly', 'readWrite', 'maxReadOnly', 'maxReadWrite', 'denyRead'] as const) {
    const values = c[name] ?? [];
    if (!Array.isArray(values) || values.length > 64 || values.some(p => typeof p !== 'string' || p.length > 4096 ||
        !p.length || !(isAbsolute(p) || p.startsWith('~/')) || /[\x00-\x1f\x7f*?[\]{}]/.test(p))) throw new Error(`Invalid ${name}: use literal absolute paths or ~/ paths`);
    result[name] = values.map(p => canonicalPath(expand(p)));
  }
  if (c.socatPath !== undefined) {
    if (typeof c.socatPath !== 'string' || !isAbsolute(c.socatPath) || /[\x00-\x1f\x7f]/.test(c.socatPath)) throw new Error('Invalid socatPath');
    result.socatPath = existsSync(c.socatPath) ? realpathSync(c.socatPath) : c.socatPath;
  }
  if (c.hostCommands !== undefined) result.hostCommands = validateHostCommands(c.hostCommands);
  return result;
}

const hostName = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const hostEnvName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const hostPlaceholderSet = new Set<string>(hostPlaceholders);
function validateHostCommands(value: unknown): HostCommand[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid hostCommands: expected an array of at most 16 commands');
  const seen = new Set<string>();
  return value.map((entry): HostCommand => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid hostCommands entry');
    const command = entry as Record<string, unknown>;
    if (Object.keys(command).some(key => !['name', 'path', 'starts', 'env', 'delegable', 'operations'].includes(key))) throw new Error('Invalid hostCommands entry');
    if (typeof command.name !== 'string' || !hostName.test(command.name)) throw new Error('Invalid hostCommands name: use 1-64 of a-z, 0-9, - or _');
    if (seen.has(command.name)) throw new Error(`Duplicate hostCommands name: ${command.name}`);
    seen.add(command.name);
    if (typeof command.path !== 'string' || !isAbsolute(command.path) || /[\x00-\x1f\x7f]/.test(command.path)) throw new Error('Invalid hostCommands path: use an absolute path');
    if (command.starts !== undefined && (typeof command.starts !== 'string' || !hostName.test(command.starts))) throw new Error('Invalid hostCommands starts');
    if (command.delegable !== undefined && typeof command.delegable !== 'boolean') throw new Error('Invalid hostCommands delegable: use a boolean');
    if (command.delegable === true && command.starts !== undefined) throw new Error(`hostCommands ${command.name} cannot be delegable and start another child`);
    if (command.env !== undefined && (!Array.isArray(command.env) || command.env.length > 32 || command.env.some(name => typeof name !== 'string' || !hostEnvName.test(name))))
      throw new Error('Invalid hostCommands env: use up to 32 environment variable names matching [A-Za-z_][A-Za-z0-9_]*');
    if (!Array.isArray(command.operations) || !command.operations.length || command.operations.length > 32) throw new Error('Invalid hostCommands operations: expected 1-32 entries');
    const names = new Set<string>();
    const operations = command.operations.map((item): HostOperation => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid hostCommands operation');
      const operation = item as Record<string, unknown>;
      if (Object.keys(operation).some(key => !['name', 'argv', 'timeoutSeconds'].includes(key))) throw new Error('Invalid hostCommands operation');
      if (typeof operation.name !== 'string' || !hostName.test(operation.name)) throw new Error('Invalid hostCommands operation name');
      if (names.has(operation.name)) throw new Error(`Duplicate hostCommands operation: ${operation.name}`);
      names.add(operation.name);
      if (!Array.isArray(operation.argv) || !operation.argv.length || operation.argv.length > 64 ||
          operation.argv.some(arg => typeof arg !== 'string' || !arg.length || arg.length > 4096 || /[\x00\x1f\x7f]/.test(arg))) throw new Error('Invalid hostCommands argv: expected 1-64 non-empty strings');
      for (const arg of operation.argv as string[]) {
        if (/[{}]/.test(arg) && !/^\{[a-z]+\}$/.test(arg)) throw new Error(`Invalid hostCommands argument: placeholders must fill the whole argument (${arg})`);
        const placeholders = arg.match(/\{[a-z]+\}/g) ?? [];
        if (placeholders.some(name => !hostPlaceholderSet.has(name))) throw new Error(`Invalid hostCommands placeholder in ${arg}`);
        if (command.delegable === true && placeholders.some(name => name === '{hiraishi}' || name === '{grants}'))
          throw new Error(`hostCommands ${command.name} is delegable and cannot use {hiraishi} or {grants}`);
      }
      if (command.starts === operation.name && !(operation.argv as string[]).includes('{grants}')) throw new Error('hostCommands starts must pass {grants} so the child cannot bypass the session ceiling');
      if ((operation.argv as string[]).includes('{hiraishi}') && !(operation.argv as string[]).includes('{grants}'))
        throw new Error('hostCommands operations that start {hiraishi} must pass {grants} so the child inherits the session ceiling');
      const timeoutSeconds = operation.timeoutSeconds;
      if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || (timeoutSeconds as number) < 1 || (timeoutSeconds as number) > 3600)) throw new Error('Invalid hostCommands timeoutSeconds');
      return { name: operation.name, argv: operation.argv as string[], ...(timeoutSeconds !== undefined ? { timeoutSeconds: timeoutSeconds as number } : {}) };
    });
    if (command.starts !== undefined && !names.has(command.starts as string)) throw new Error('hostCommands starts must name an operation');
    return { name: command.name, path: command.path, ...(command.starts !== undefined ? { starts: command.starts as string } : {}), ...(command.env !== undefined ? { env: [...new Set(command.env as string[])] } : {}), ...(command.delegable === true ? { delegable: true } : {}), operations };
  });
}
export function loadConfig(path: string): Config {
  try { return validateConfig(parseJsonc(readFileSync(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateConfig({}); throw error; }
}

export type Grants = Partial<Pick<Config, 'networkMode' | 'maxNetworkMode' | 'readOnly' | 'readWrite' | 'denyRead'>> & {
  hostCommands?: string[];
  replace?: Partial<Pick<Config, 'readOnly' | 'readWrite'>>;
  /** Canonical workspace the child must start in; the child verifies it itself. */
  expectedCwd?: string;
  /** Drop host commands for this session so a delegated child cannot delegate again. */
  noHostCommands?: boolean;
};
export interface Ceiling { networkMode: NetworkMode; readOnly: string[]; readWrite: string[] }
export const networkRank = (mode: NetworkMode) => mode === 'off' ? 0 : mode === 'http-get' ? 1 : 2;
export const ceilingOf = (config: Config, cwd?: string): Ceiling => ({
  networkMode: config.maxNetworkMode,
  readOnly: [...config.readOnly, ...config.maxReadOnly, ...config.maxReadWrite, ...(cwd ? [cwd] : [])],
  readWrite: [...config.readWrite, ...config.maxReadWrite, ...(cwd ? [cwd] : [])],
});

const pathList = (value: unknown, name: string) => {
  if (!Array.isArray(value)) throw new Error(`Invalid --hiraishi-grants: ${name} must be an array`);
  return value;
};

// Caller-supplied session grants (--hiraishi-grants). socatPath stays host-controlled.
export function parseGrants(json: string): Grants {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error('Invalid --hiraishi-grants: not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid --hiraishi-grants: expected a JSON object');
  const raw = value as Record<string, unknown>;
  if ('socatPath' in raw) throw new Error('Invalid --hiraishi-grants: socatPath cannot be set from the command line');
  if ('maxReadOnly' in raw || 'maxReadWrite' in raw) throw new Error('Invalid --hiraishi-grants: maxReadOnly and maxReadWrite are configuration-only ceilings');
  const { replace, cwd: expectedCwd, noHostCommands, hostCommands, ...rest } = raw;
  if (expectedCwd !== undefined && (typeof expectedCwd !== 'string' || !isAbsolute(expectedCwd))) throw new Error('Invalid --hiraishi-grants: cwd must be an absolute path');
  if (noHostCommands !== undefined && typeof noHostCommands !== 'boolean') throw new Error('Invalid --hiraishi-grants: noHostCommands must be a boolean');
  if (hostCommands !== undefined && (!Array.isArray(hostCommands) || hostCommands.length > 16 || hostCommands.some(name => typeof name !== 'string' || !hostName.test(name))))
    throw new Error('Invalid --hiraishi-grants: hostCommands must be an array of configured command names');
  for (const name of ['readOnly', 'readWrite', 'denyRead'] as const) if (name in rest) pathList(rest[name], name);
  const config = validateConfig(rest);
  const grants: Grants = {};
  if ('networkMode' in rest) grants.networkMode = config.networkMode;
  if ('maxNetworkMode' in rest) grants.maxNetworkMode = config.maxNetworkMode;
  if ('readOnly' in rest) grants.readOnly = config.readOnly;
  if ('readWrite' in rest) grants.readWrite = config.readWrite;
  if ('denyRead' in rest) grants.denyRead = config.denyRead;
  if (expectedCwd !== undefined) grants.expectedCwd = canonicalPath(expectedCwd);
  if (noHostCommands !== undefined) grants.noHostCommands = noHostCommands;
  if (hostCommands !== undefined) grants.hostCommands = [...new Set(hostCommands as string[])];
  if (grants.networkMode && grants.maxNetworkMode && networkRank(grants.networkMode) > networkRank(grants.maxNetworkMode))
    throw new Error('Invalid --hiraishi-grants: networkMode cannot exceed maxNetworkMode');
  if (replace !== undefined) {
    if (!replace || typeof replace !== 'object' || Array.isArray(replace)) throw new Error('Invalid --hiraishi-grants: replace must be an object');
    const exact = replace as Record<string, unknown>;
    if (Object.keys(exact).some(key => !['readOnly', 'readWrite'].includes(key))) throw new Error('Invalid --hiraishi-grants: replace accepts readOnly and readWrite');
    for (const name of ['readOnly', 'readWrite'] as const) {
      if (name in exact && name in rest) throw new Error(`Invalid --hiraishi-grants: use either ${name} or replace.${name}, not both`);
      if (name in exact) pathList(exact[name], `replace.${name}`);
    }
    const validated = validateConfig({ networkMode: 'off', ...exact });
    grants.replace = {
      ...('readOnly' in exact ? { readOnly: validated.readOnly } : {}),
      ...('readWrite' in exact ? { readWrite: validated.readWrite } : {}),
    };
  }
  return grants;
}

// Grants may narrow the session ceiling, add directories, or (via replace) drop baseline directories.
export function ceilingViolations(grants: Grants, ceiling: Ceiling): string[] {
  const violations: string[] = [];
  for (const key of ['networkMode', 'maxNetworkMode'] as const) {
    const value = grants[key];
    if (value && networkRank(value) > networkRank(ceiling.networkMode))
      violations.push(`${key} ${value} exceeds the session ceiling ${ceiling.networkMode}`);
  }
  for (const name of ['readOnly', 'readWrite'] as const) {
    const roots = ceiling[name].map(canonicalPath);
    for (const path of [...(grants[name] ?? []), ...(grants.replace?.[name] ?? [])]) {
      if (!roots.some(root => within(canonicalPath(path), root)))
        violations.push(`${name} ${path} is outside the session ceiling`);
    }
  }
  return violations;
}

// Merge-time normalization also bounds any later symlink swap.
export function canonicalGrants(grants: Grants): Grants {
  const exact = grants.replace;
  return {
    ...(grants.networkMode ? { networkMode: grants.networkMode } : {}),
    ...(grants.maxNetworkMode ? { maxNetworkMode: grants.maxNetworkMode } : {}),
    ...(grants.readOnly ? { readOnly: grants.readOnly.map(canonicalPath) } : {}),
    ...(grants.readWrite ? { readWrite: grants.readWrite.map(canonicalPath) } : {}),
    ...(grants.denyRead ? { denyRead: grants.denyRead.map(canonicalPath) } : {}),
    ...(grants.hostCommands ? { hostCommands: [...new Set(grants.hostCommands)] } : {}),
    ...(grants.expectedCwd ? { cwd: canonicalPath(grants.expectedCwd) } : {}),
    ...(grants.noHostCommands ? { noHostCommands: grants.noHostCommands } : {}),
    ...(exact ? { replace: {
      ...(exact.readOnly ? { readOnly: exact.readOnly.map(canonicalPath) } : {}),
      ...(exact.readWrite ? { readWrite: exact.readWrite.map(canonicalPath) } : {}),
    } } : {}),
  };
}

// A host command keep-list may only name configured commands, and never one that starts another child.
function selectHostCommands(baseline: Config, grants: Grants): HostCommand[] | undefined {
  const requested = grants.hostCommands;
  if (requested !== undefined) {
    const configured = new Map((baseline.hostCommands ?? []).map(command => [command.name, command]));
    const names = [...new Set(requested)];
    for (const name of names) {
      const command = configured.get(name);
      if (!command) throw new Error(`Invalid --hiraishi-grants: unknown host command ${name}`);
      if (command.starts) throw new Error(`Invalid --hiraishi-grants: host command ${name} starts another child and cannot be delegated`);
    }
    return names.length ? names.map(name => configured.get(name)!) : undefined;
  }
  return grants.noHostCommands ? undefined : baseline.hostCommands;
}

// Unspecified fields inherit the baseline. Directory grants are additive unless replace names them explicitly;
// denyRead only ever grows. An explicit grant ceiling (maxNetworkMode, else networkMode) caps the session; a value
// above the configured maximum is only reached after the user approves it. Paths are canonicalized here so a later
// symlink swap is detectable at startup.
export function mergeGrants(baseline: Config, grants: Grants): Config {
  const unique = (paths: string[]) => [...new Set(paths.map(canonicalPath))];
  const ceiling = grants.maxNetworkMode ?? grants.networkMode ?? baseline.maxNetworkMode;
  const start = grants.networkMode ?? baseline.networkMode;
  const hostCommands = selectHostCommands(baseline, grants);
  return {
    networkMode: networkRank(start) <= networkRank(ceiling) ? start : ceiling,
    maxNetworkMode: ceiling,
    readOnly: grants.replace?.readOnly !== undefined ? unique(grants.replace.readOnly) : unique([...baseline.readOnly, ...(grants.readOnly ?? [])]),
    readWrite: grants.replace?.readWrite !== undefined ? unique(grants.replace.readWrite) : unique([...baseline.readWrite, ...(grants.readWrite ?? [])]),
    // A host-launched child gets exactly the grants the parent passed, so its own configuration cannot widen them.
    maxReadOnly: grants.noHostCommands ? [] : unique(baseline.maxReadOnly),
    maxReadWrite: grants.noHostCommands ? [] : unique(baseline.maxReadWrite),
    denyRead: unique([...baseline.denyRead, ...(grants.denyRead ?? [])]),
    socatPath: baseline.socatPath,
    ...(hostCommands ? { hostCommands } : {}),
  };
}
// "Start with baseline" keeps every restriction the request asked for while dropping its additions.
export function restrictGrants(baseline: Config, grants: Grants): Config {
  const ceiling = ceilingOf(baseline);
  const requested = grants.maxNetworkMode ?? grants.networkMode;
  const lowered = requested && networkRank(requested) < networkRank(baseline.maxNetworkMode) ? requested : baseline.maxNetworkMode;
  const replace = grants.replace && ceilingViolations({ replace: grants.replace }, ceiling).length === 0 ? grants.replace : undefined;
  return mergeGrants({ ...baseline, maxNetworkMode: lowered }, {
    ...(replace ? { replace } : {}),
    ...(grants.denyRead ? { denyRead: grants.denyRead } : {}),
    ...(grants.hostCommands ? { hostCommands: grants.hostCommands } : {}),
    ...(grants.noHostCommands ? { noHostCommands: true } : {}),
  });
}

const systemWriteRoots = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/proc', '/sys', '/dev', '/run'];
const systemReadPaths = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/pki', '/etc/ld.so.cache', '/etc/hosts', '/etc/resolv.conf', '/etc/nsswitch.conf'];
export const privateAddressRanges = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8', '2001:db8::/32'];

// SRT's resolved-address guard exempts literal IP destinations and localhost names.
export function allowsHost(mode: NetworkMode, host: string): boolean {
  if (mode === 'off') return false;
  try {
    const normalized = new URL(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}`).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    return !isIP(normalized) && normalized !== 'localhost' && !normalized.endsWith('.localhost') && normalized.includes('.');
  } catch { return false; }
}
export const NETWORK_DENIAL_GUIDANCE = 'When sandbox network access is denied, if fresh information is needed or network access would make progress more efficient, pause the affected work instead of silently relying on memory or guesses. Explain the missing information and ask the user to choose: continue offline with explicit limitations, or enable the minimum necessary session network mode (/hiraishi-network http-get for GET/HEAD, /hiraishi-network http-all for other HTTP methods). Wait for their answer; never change permissions yourself. If delegated, return the choice to the parent. Do not suggest a mode change for destinations or protocols blocked in every mode.';

export const SUBAGENT_NETWORK_DENIAL_GUIDANCE = 'Subagent network access was denied. Stop the affected work and return the exact operation and minimum necessary permission to the parent. The parent may retry hiraishi_subagent with permissions.networkMode=http-get for GET/HEAD or http-all for other HTTP methods when user authorization covers it; if unsure, set permissions.approval=user so the user can choose. Do not request extra permission for destinations or protocols blocked in every mode.';
export const networkDenialGuidance = (delegated = false) => delegated ? SUBAGENT_NETWORK_DENIAL_GUIDANCE : NETWORK_DENIAL_GUIDANCE;

export function hostDecision(mode: NetworkMode, host: string, delegated = false): true | { allow: false; reason: string } {
  return allowsHost(mode, host) ? true : { allow: false, reason: `Hiraishi network mode ${mode}: ${mode === 'off' ? 'external network is disabled' : 'a public DNS hostname is required; literal IPs, localhost and single-label names are not permitted'}. ${networkDenialGuidance(delegated)}` };
}
export interface PolicyInput { cwd: string; configPath: string; runtimeRoot: string; srtRoot: string; temp: string; home: string; mode: NetworkMode; config: Config; agentDir?: string; delegated?: boolean }
// Grants are canonicalized when validated, so a path that resolves elsewhere now was swapped after the fact.
function strictPath(path: string): string {
  const real = realpathSync(path);
  if (real !== path) throw new Error(`Grant path changed since it was validated; start a new session: ${path}`);
  return real;
}
export function runtimePolicy(input: PolicyInput): SandboxRuntimeConfig {
  const { config, mode, temp, home } = input;
  const cwd = strictPath(input.cwd);
  const hostHome = canonicalPath(homedir());
  const agentDirs = [...new Set([input.agentDir ?? join(homedir(), '.pi/agent'), join(homedir(), '.pi/agent')].map(canonicalPath))];
  const sessionRoot = canonicalPath(dirname(temp));
  const userWrites = [cwd, ...config.readWrite.map(strictPath)];
  const userReads = config.readOnly.map(strictPath);
  for (const path of [...userWrites, ...userReads]) {
    if (overlaps(path, sessionRoot)) throw new Error(`Grant overlaps private SRT session state: ${path}`);
  }
  for (const path of userReads) {
    if (!statSync(path).isDirectory()) throw new Error(`readOnly must name directories: ${path}`);
    if (within(hostHome, path)) throw new Error(`Read grant exposes HOME or its ancestor: ${path}`);
    if (agentDirs.some(agent => within(agent, path))) throw new Error(`Read grant exposes pi state; grant a specific skills directory instead: ${path}`);
  }
  for (const path of userWrites) {
    if (agentDirs.some(agent => overlaps(path, agent))) throw new Error(`Write grant exposes pi state: ${path}`);
  }
  const writes = [...userWrites, temp, home];
  for (const path of writes) {
    if (!statSync(path).isDirectory() || within(hostHome, path) || systemWriteRoots.some(p => within(p, path) || within(path, p)) || ['/tmp', '/private/tmp'].some(p => within(p, path))) throw new Error(`Writable directory is too broad: ${path}`);
    for (const protectedPath of [input.runtimeRoot, input.srtRoot, input.configPath, process.execPath, config.socatPath].filter((p): p is string => !!p)) {
      const target = canonicalPath(protectedPath);
      if (within(target, path)) throw new Error(`Install runtime and configuration outside writable directories: ${protectedPath}`);
    }
  }
  const reads = [...systemReadPaths, dirname(process.execPath), input.srtRoot, ...(config.socatPath ? [config.socatPath] : []), ...userReads, ...writes].filter(existsSync);
  const denied = [...config.denyRead.map(canonicalPath), ...agentDirs.flatMap(dir => [join(dir, 'auth.json'), join(dir, 'models.json'), join(dir, 'sessions')]), join(hostHome, '.ssh'), join(hostHome, '.aws'), join(hostHome, '.gnupg'), join(hostHome, '.netrc'), canonicalPath(input.configPath), '/tmp/claude', '/private/tmp/claude'];
  return {
    filesystem: { denyRead: [literal('/'), ...denied.map(literal)], allowRead: reads.map(literal), allowWrite: writes.map(literal),
      denyWrite: [...agentDirs, input.runtimeRoot, input.srtRoot, input.configPath, process.execPath, '/tmp/claude', '/private/tmp/claude'].map(literal) },
    credentials: { files: denied.map(path => ({ path, mode: 'deny' as const })) },
    network: {
      allowedDomains: [], deniedDomains: [], deniedResolvedAddresses: privateAddressRanges,
      allowAllUnixSockets: false, allowLocalBinding: false, refuseOpaqueTunnels: true, requireHostMatch: true,
      tlsTerminate: { excludeDomains: [] },
      filterRequest: async request => {
        const allowed = mode !== 'off' && !request.headers.has('upgrade') && request.method !== 'CONNECT' &&
          (mode === 'http-all' || request.method === 'GET' || request.method === 'HEAD');
        return allowed ? { action: 'allow' } : { action: 'deny', reason: `Hiraishi network mode ${mode}: request refused. ${networkDenialGuidance(input.delegated)}` };
      },
    },
    ...(config.socatPath ? { socatPath: config.socatPath } : {}),
    git: { safeDirectories: [cwd] },
  };
}
