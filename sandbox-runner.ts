import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isLocale, messages, type Locale } from './messages.ts';

export const MAX_SCRIPT_BYTES = 65536;
export const RUNTIMES: Record<string, string> = { ruby: '/usr/bin/ruby', python: '/usr/bin/python3', python3: '/usr/bin/python3' };
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
function readRoots(cwd: string): string[] {
  if (!isAbsolute(cwd) || cwd === '/' || cwd === tmpdir() || !existsSync(cwd)) throw new Error('invalid project directory');
  const roots: string[] = [];
  let count = 0;
  const visit = (path: string): void => {
    if (++count > 10000) throw new Error('project tree is too large to inspect');
    const name = path.split('/').at(-1)!;
    if (/^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.gnupg|auth\.json|credentials(?:\..*)?|master\.key)$|\.(?:pem|key)$/i.test(name)) throw new Error('sensitive files in code directories');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error('links or special files in code directories');
    if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  for (const name of ['lib', 'src', 'spec', 'test']) {
    const path = join(cwd, name);
    if (existsSync(path)) { visit(path); roots.push(path); }
  }
  return roots;
}
export function sandboxArguments(cwd: string, script: string, snapshot: string, runtime: string, args: string[]): string[] {
  if (process.platform !== 'linux') throw new Error('sandbox requires Linux');
  cwd = realpathSync(cwd);
  if (!Object.values(RUNTIMES).includes(runtime) || !existsSync(runtime) ||
      !isAbsolute(script) || !script.startsWith('/tmp/') || script.startsWith(cwd + '/') || !isAbsolute(snapshot)) throw new Error('unsupported sandbox invocation');
  const roots = readRoots(cwd);
  const result = [
    '--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--disable-userns',
    '--ro-bind', '/usr', '/usr',
    ...['/bin', '/sbin', '/lib', '/lib64'].filter(path => existsSync(path)).flatMap(path => ['--ro-bind', path, path]),
    '--proc', '/proc', '--dev', '/dev', '--size', '67108864', '--tmpfs', '/tmp', '--dir', cwd,
    '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'PYTHONDONTWRITEBYTECODE', '1', '--setenv', 'PYTHONNOUSERSITE', '1',
  ];
  for (const root of roots) result.push('--ro-bind', root, root);
  result.push('--ro-bind', snapshot, script, '--chdir', cwd, '--', '/usr/bin/prlimit', '--nproc=64', '--', runtime, script, ...args);
  return result;
}
export function runSandbox(script: string, hash: string, cwd: string, runtime: string, args: string[]): number {
  const snap = scriptSnapshot(script);
  if (snap.hash !== hash) throw new Error('script changed after review');
  const temporary = mkdtempSync(join(tmpdir(), 'pi-hiraishi-snapshot-'));
  try {
    const snapshot = join(temporary, 'source');
    writeFileSync(snapshot, snap.source, { mode: 0o400 });
    const bwrap = sandboxArguments(cwd, script, snapshot, runtime, args);
    const result = spawnSync('/usr/bin/prlimit', [
      '--as=1073741824', '--cpu=10', '--fsize=8388608', '--', '/usr/bin/bwrap', ...bwrap,
    ], { stdio: 'inherit', timeout: 15000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    if (result.error || result.signal) throw new Error('sandbox failed or exceeded limits');
    return result.status ?? 1;
  } finally { rmSync(temporary, { recursive: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [script, hash, cwd, runtime, ...args] = process.argv.slice(2);
  try {
    if (!script || !hash || !cwd || !runtime || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid invocation');
    process.exitCode = runSandbox(script, hash, cwd, runtime, args);
  } catch {
    const locale: Locale = isLocale(process.env.HIRAISHI_LOCALE) ? process.env.HIRAISHI_LOCALE : 'en';
    process.stderr.write(messages[locale].sandbox.failed + '\n');
    process.exitCode = 1;
  }
}
