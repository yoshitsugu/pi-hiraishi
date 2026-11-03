import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

export type NetworkMode = 'off' | 'http-get' | 'http-all';
export interface Config {
  networkMode: NetworkMode;
  readOnly: string[];
  readWrite: string[];
  denyRead: string[];
  socatPath?: string;
}
export const isNetworkMode = (value: unknown): value is NetworkMode => ['off', 'http-get', 'http-all'].includes(value as string);
export const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
export const expand = (path: string) => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(absolute) === absolute) throw error;
    return join(canonicalPath(dirname(absolute)), basename(absolute));
  }
}
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const literal = (path: string) => ({ path, literal: true as const });

export function parseJsonc(text: string): unknown {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g, match => match.startsWith('/') ? ' ' : match));
}
export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Hiraishi configuration');
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some(k => !['networkMode', 'readOnly', 'readWrite', 'denyRead', 'socatPath'].includes(k)) ||
      c.networkMode !== undefined && !isNetworkMode(c.networkMode)) throw new Error('Invalid Hiraishi configuration; old classifier settings are no longer supported');
  const result: Config = { networkMode: c.networkMode as NetworkMode ?? 'off', readOnly: [], readWrite: [], denyRead: [] };
  for (const name of ['readOnly', 'readWrite', 'denyRead'] as const) {
    const values = c[name] ?? [];
    if (!Array.isArray(values) || values.length > 64 || values.some(p => typeof p !== 'string' || p.length > 4096 ||
        !p.length || !(isAbsolute(p) || p.startsWith('~/')) || /[\x00-\x1f\x7f*?[\]{}]/.test(p))) throw new Error(`Invalid ${name}: use literal absolute paths or ~/ paths`);
    result[name] = values.map(expand);
  }
  if (c.socatPath !== undefined) {
    if (typeof c.socatPath !== 'string' || !isAbsolute(c.socatPath) || /[\x00-\x1f\x7f]/.test(c.socatPath)) throw new Error('Invalid socatPath');
    result.socatPath = existsSync(c.socatPath) ? realpathSync(c.socatPath) : c.socatPath;
  }
  return result;
}
export function loadConfig(path: string): Config {
  try { return validateConfig(parseJsonc(readFileSync(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateConfig({}); throw error; }
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
export function runtimePolicy(input: PolicyInput): SandboxRuntimeConfig {
  const { config, mode, temp, home } = input;
  const cwd = realpathSync(input.cwd);
  const hostHome = canonicalPath(homedir());
  const agentDirs = [...new Set([input.agentDir ?? join(homedir(), '.pi/agent'), join(homedir(), '.pi/agent')].map(canonicalPath))];
  const sessionRoot = canonicalPath(dirname(temp));
  const userWrites = [cwd, ...config.readWrite.map(p => realpathSync(p))];
  const userReads = config.readOnly.map(p => realpathSync(p));
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
