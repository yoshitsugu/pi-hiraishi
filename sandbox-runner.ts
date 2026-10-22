import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isLocale, messages, type Locale } from './messages.ts';

export const MAX_SCRIPT_BYTES = 65536;
export interface SandboxConfig { command: string[]; timeoutMs?: number }
export function validateSandbox(value: unknown): SandboxConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid sandbox config');
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => !['command', 'timeoutMs'].includes(key)) ||
      !Array.isArray(config.command) || config.command.length === 0 || config.command.length > 64 ||
      !config.command.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(arg)) ||
      !isAbsolute(config.command[0]) ||
      (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || (config.timeoutMs as number) < 1 || (config.timeoutMs as number) > 600000)))
    throw new Error('invalid sandbox config');
  return config as unknown as SandboxConfig;
}
export function scriptSnapshot(path: string): { source: string; hash: string; resolved: string } {
  const resolved = realpathSync(path);
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) throw new Error('not a small regular script');
    const buffer = Buffer.alloc(MAX_SCRIPT_BYTES + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      size += count;
      if (count === 0 || size === buffer.length) break;
    }
    const bytes = buffer.subarray(0, size);
    if (bytes.length > MAX_SCRIPT_BYTES || bytes.includes(0)) throw new Error('invalid script');
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { source, resolved, hash: createHash('sha256').update(bytes).digest('hex') };
  } finally { closeSync(fd); }
}
export function runSandbox(script: string, hash: string, cwd: string, runtime: string, args: string[], config: SandboxConfig): number {
  config = validateSandbox(config);
  if (!isAbsolute(cwd) || !isAbsolute(script) || !runtime) throw new Error('invalid sandbox invocation');
  const snap = scriptSnapshot(script);
  if (snap.hash !== hash || snap.resolved !== script) throw new Error('script changed after review');
  const result = spawnSync(config.command[0]!, config.command.slice(1), {
    cwd,
    input: JSON.stringify({ version: 1, cwd, script, hash, source: snap.source, runtime, args }),
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: config.timeoutMs ?? 15000,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.signal) throw new Error('sandbox executor failed or exceeded limits');
  return result.status ?? 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [settings, script, hash, cwd, runtime, ...args] = process.argv.slice(2);
  try {
    if (!settings || !script || !hash || !cwd || !runtime || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid invocation');
    process.exitCode = runSandbox(script, hash, cwd, runtime, args, validateSandbox(JSON.parse(settings)));
  } catch {
    const locale: Locale = isLocale(process.env.HIRAISHI_LOCALE) ? process.env.HIRAISHI_LOCALE : 'en';
    process.stderr.write(messages[locale].sandbox.failed + '\n');
    process.exitCode = 1;
  }
}
