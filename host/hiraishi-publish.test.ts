import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'hiraishi-publish');
const identity = ['-c', 'user.name=Hiraishi Test', '-c', 'user.email=hiraishi@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' };
delete env.HOME;
delete env.XDG_STATE_HOME;
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', [...identity, ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

interface Fixture {
  root: string;
  bin: string;
  home: string;
  remote: string;
  seed: string;
  work: string;
  base: string;
  bundle: string;
}

function fixture(): Fixture {
  const root = mkdtempSync('/tmp/hiraishi-publish-');
  const home = join(root, 'home');
  mkdirSync(home);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  copyFileSync(script, join(bin, 'hiraishi-publish'));
  chmodSync(join(bin, 'hiraishi-publish'), 0o755);

  const remote = join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', remote);

  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '--quiet');
  git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'base');
  git(seed, 'push', '--quiet', remote, 'main');
  const base = git(seed, 'rev-parse', 'HEAD');

  const work = join(root, 'work');
  git(root, 'clone', '--quiet', remote, work);
  git(work, 'commit', '--quiet', '--allow-empty', '-m', 'change one');
  git(work, 'commit', '--quiet', '--allow-empty', '-m', 'change two');
  const bundle = join(work, '.hiraishi-out.bundle');
  git(work, 'bundle', 'create', bundle, `${base}..HEAD`);

  writeAllowlist(bin, [{ path: realpathSync(work), remote }]);
  return { root, bin, home, remote, seed, work, base, bundle };
}

function writeAllowlist(bin: string, repos: { path: string; remote: string }[]) {
  writeFileSync(join(bin, 'publish-allow.json'), JSON.stringify({ repos }));
}

function publish(fx: Fixture, workdir: string, bundle: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(join(fx.bin, 'hiraishi-publish'), [workdir, bundle], {
    cwd: fx.bin, encoding: 'utf8', timeout: 120_000,
    env: { ...env, HOME: fx.home, XDG_STATE_HOME: join(fx.root, 'state'), TMPDIR: fx.root, HIRAISHI_PUBLISH_DEBUG: '', ...extraEnv },
  });
}

function output(text: string) {
  const match = /^branch: (hiraishi\/\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{8})\ntip: ([0-9a-f]{40})\ncommits: (\d+)\n$/.exec(text);
  assert.ok(match, `unexpected output: ${JSON.stringify(text)}`);
  return { branch: match[1]!, tip: match[2]!, commits: Number(match[3]) };
}

function withFixture(run: (fx: Fixture) => void) {
  const fx = fixture();
  try { run(fx); } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

function installFakeGit(fx: Fixture): string {
  const dir = join(fx.root, 'fakebin');
  mkdirSync(dir);
  const wrapper = [
    '#!/bin/sh',
    `real='${realGit}'`,
    'if [ -n "${FAKE_ARG_LOG:-}" ]; then printf \'%s\\n\' "$*" >> "$FAKE_ARG_LOG"; fi',
    'refspec=',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    *:refs/heads/*) refspec=$arg ;;',
    '  esac',
    'done',
    'if [ -n "${FAKE_FAIL_REV_LIST:-}" ]; then',
    '  for arg in "$@"; do',
    '    if [ "$arg" = "rev-list" ]; then exit 128; fi',
    '  done',
    'fi',
    'if [ -n "${FAKE_FAIL_REV_LIST_NTH:-}" ]; then',
    '  for arg in "$@"; do',
    '    if [ "$arg" = "rev-list" ]; then',
    '      count=0',
    '      [ -f "${FAKE_REV_LIST_COUNTER:-/nonexistent}" ] && count=$(cat "$FAKE_REV_LIST_COUNTER")',
    '      count=$((count + 1))',
    '      printf \'%s\\n\' "$count" > "${FAKE_REV_LIST_COUNTER:-/nonexistent}"',
    '      if [ "$count" = "$FAKE_FAIL_REV_LIST_NTH" ]; then exit 128; fi',
    '      break',
    '    fi',
    '  done',
    'fi',
    'if [ -n "${FAKE_FAIL_CAT_FILE:-}" ]; then',
    '  for arg in "$@"; do',
    '    if [ "$arg" = "cat-file" ]; then exit 128; fi',
    '  done',
    'fi',
    'if [ -n "${FAKE_FAIL_LS_REMOTE:-}" ]; then',
    '  for arg in "$@"; do',
    '    if [ "$arg" = "ls-remote" ]; then exit 128; fi',
    '  done',
    'fi',
    'if [ -n "${FAKE_VERIFY_REPLACE:-}" ] && [ -n "${FAKE_VERIFY_PATH:-}" ] && [ ! -e "${FAKE_MARKER:-/nonexistent}" ]; then',
    '  for arg in "$@"; do',
    '    if [ "$arg" = "verify" ]; then',
    '      : > "$FAKE_MARKER"',
    '      ln -sfn "$FAKE_VERIFY_REPLACE" "$FAKE_VERIFY_PATH"',
    '      break',
    '    fi',
    '  done',
    'fi',
    'if [ -n "${FAKE_RACE_REMOTE:-}" ] && [ -n "$refspec" ] && [ ! -e "${FAKE_RACE_MARKER:-/nonexistent}" ]; then',
    '  for arg in "$@"; do',
    '    if [ "$arg" = "push" ]; then',
    '      : > "$FAKE_RACE_MARKER"',
    '      branch=${refspec#*:refs/heads/}',
    '      "$real" -C "$FAKE_RACE_REMOTE" branch "$branch" main',
    '      break',
    '    fi',
    '  done',
    'fi',
    'exec "$real" "$@"',
  ].join('\n') + '\n';
  const path = join(dir, 'git');
  writeFileSync(path, wrapper);
  chmodSync(path, 0o755);
  return dir;
}

function fakePath(fakeDir: string) {
  return `${fakeDir}:${env.PATH ?? ''}`;
}

function installFakeGrep(fx: Fixture, code: number): string {
  const dir = join(fx.root, 'fakegrep');
  mkdirSync(dir);
  writeFileSync(join(dir, 'grep'), `#!/bin/sh\nexit ${code}\n`);
  chmodSync(join(dir, 'grep'), 0o755);
  return dir;
}

function commandPath(name: string): string {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', env });
  assert.equal(result.status, 0, `missing ${name}`);
  return result.stdout.trim();
}

const remoteBranches = (fx: Fixture) => git(fx.remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/hiraishi').split('\n').filter(Boolean);

test('publishes the bundle tip as a new branch without moving the default branch', () => withFixture(fx => {
  const result = publish(fx, fx.work, fx.bundle);
  assert.equal(result.status, 0, result.stderr);
  const published = output(result.stdout);
  assert.equal(published.tip, git(fx.work, 'rev-parse', 'HEAD'));
  assert.equal(published.commits, 2);
  assert.equal(git(fx.remote, 'rev-parse', `refs/heads/${published.branch}`), published.tip);
  assert.equal(git(fx.remote, 'rev-parse', 'refs/heads/main'), fx.base);
}));

test('accepts a bundle that carries a prerequisite', () => withFixture(fx => {
  const verify = spawnSync('git', [...identity, 'bundle', 'verify', fx.bundle], { cwd: fx.work, env, encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(`${verify.stdout}${verify.stderr}`, /requires this ref/);
  const result = publish(fx, fx.work, fx.bundle);
  assert.equal(result.status, 0, result.stderr);
}));

test('refuses a work directory that is not in the allowlist, including through a symlink', () => withFixture(fx => {
  const other = join(fx.root, 'other');
  mkdirSync(other);
  git(other, 'init', '--quiet');
  git(other, 'commit', '--quiet', '--allow-empty', '-m', 'other');
  const otherBundle = join(other, 'out.bundle');
  git(other, 'bundle', 'create', otherBundle, 'main');

  const direct = publish(fx, other, otherBundle);
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /not allowed/);
  assert.doesNotMatch(direct.stderr, new RegExp(fx.bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  symlinkSync(other, join(fx.work, 'link'));
  const throughLink = publish(fx, join(fx.work, 'link'), otherBundle);
  assert.notEqual(throughLink.status, 0);
  assert.match(throughLink.stderr, /not allowed/);
}));

test('refuses a bundle outside the work directory', () => withFixture(fx => {
  const outside = join(fx.root, 'outside.bundle');
  copyFileSync(fx.bundle, outside);
  const result = publish(fx, fx.work, outside);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inside the work directory/);
}));

test('does not leak script paths when the bundle cannot be opened', () => withFixture(fx => {
  chmodSync(fx.bundle, 0o000);
  const result = publish(fx, fx.work, fx.bundle);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot open bundle/);
  assert.doesNotMatch(result.stderr, new RegExp(fx.bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}));

test('refuses a history that is not a descendant of the default branch tip', () => withFixture(fx => {
  const other = join(fx.root, 'unrelated');
  mkdirSync(other);
  git(other, 'init', '--quiet');
  git(other, 'commit', '--quiet', '--allow-empty', '-m', 'unrelated');
  const bundle = join(fx.work, 'unrelated.bundle');
  git(other, 'bundle', 'create', bundle, 'main');

  const result = publish(fx, fx.work, bundle);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a descendant/);
}));

test('refuses a session URL marker in an intermediate commit even when the tip is clean', () => withFixture(fx => {
  git(fx.work, 'commit', '--quiet', '--allow-empty', '-m', 'add feature\n\nclaude.ai/code/session_01AbCdEfGhIjKlMnOp');
  git(fx.work, 'commit', '--quiet', '--allow-empty', '-m', 'clean tip');
  git(fx.work, 'bundle', 'create', fx.bundle, `${fx.base}..HEAD`);

  const result = publish(fx, fx.work, fx.bundle);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session marker/);
  assert.deepEqual(remoteBranches(fx), []);
}));

test('refuses a Claude-Session: marker in an intermediate commit', () => withFixture(fx => {
  git(fx.work, 'commit', '--quiet', '--allow-empty', '-m', 'add feature\n\nClaude-Session: abc123');
  git(fx.work, 'commit', '--quiet', '--allow-empty', '-m', 'clean tip');
  git(fx.work, 'bundle', 'create', fx.bundle, `${fx.base}..HEAD`);

  const result = publish(fx, fx.work, fx.bundle);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session marker/);
  assert.deepEqual(remoteBranches(fx), []);
}));

test('refuses 51 commits', () => withFixture(fx => {
  const current = Number(git(fx.work, 'rev-list', '--count', `${fx.base}..HEAD`));
  for (let index = current; index < 51; index += 1)
    git(fx.work, 'commit', '--quiet', '--allow-empty', '-m', `commit ${index}`);
  git(fx.work, 'bundle', 'create', fx.bundle, `${fx.base}..HEAD`);

  const result = publish(fx, fx.work, fx.bundle);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /more than 50 commits/);
  assert.deepEqual(remoteBranches(fx), []);
}));

test('refuses a bundle larger than the size limit', () => withFixture(fx => {
  const huge = join(fx.work, 'huge.bundle');
  writeFileSync(huge, '');
  truncateSync(huge, MAX_BUNDLE_BYTES + 1);

  const result = publish(fx, fx.work, huge);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /larger than/);
  assert.deepEqual(remoteBranches(fx), []);
}));

test('refuses a bundle with more than one head', () => withFixture(fx => {
  git(fx.work, 'checkout', '--quiet', '-b', 'other', fx.base);
  git(fx.work, 'commit', '--quiet', '--allow-empty', '-m', 'other tip');
  git(fx.work, 'checkout', '--quiet', 'main');
  const multi = join(fx.work, 'multi.bundle');
  git(fx.work, 'bundle', 'create', multi, 'main', 'other', `^${fx.base}`);

  const result = publish(fx, fx.work, multi);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one head/);
  assert.deepEqual(remoteBranches(fx), []);
}));

test('does not push when ls-remote fails', () => withFixture(fx => {
  const fake = installFakeGit(fx);
  const result = publish(fx, fx.work, fx.bundle, { PATH: fakePath(fake), FAKE_FAIL_LS_REMOTE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not check the target branch/);
  assert.deepEqual(remoteBranches(fx), []);
}));

test('does not treat a failed rev-list or cat-file as a clean history', () => withFixture(fx => {
  const fake = installFakeGit(fx);
  const revList = publish(fx, fx.work, fx.bundle, { PATH: fakePath(fake), FAKE_FAIL_REV_LIST: '1' });
  assert.notEqual(revList.status, 0);
  assert.match(revList.stderr, /could not count commits/);
  const catFile = publish(fx, fx.work, fx.bundle, { PATH: fakePath(fake), FAKE_FAIL_CAT_FILE: '1' });
  assert.notEqual(catFile.status, 0);
  assert.match(catFile.stderr, /could not read a commit/);
  assert.deepEqual(remoteBranches(fx), []);
}));

test('does not treat a failed list rev-list as a clean history', () => withFixture(fx => {
  const fake = installFakeGit(fx);
  const counter = join(fx.root, 'rev-list.count');
  const result = publish(fx, fx.work, fx.bundle, {
    PATH: fakePath(fake), FAKE_FAIL_REV_LIST_NTH: '2', FAKE_REV_LIST_COUNTER: counter,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not list commits/);
  assert.deepEqual(remoteBranches(fx), []);
}));

test('does not push when grep exits with an error', () => withFixture(fx => {
  const fakeGrep = installFakeGrep(fx, 2);
  const result = publish(fx, fx.work, fx.bundle, { PATH: fakePath(fakeGrep) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not inspect a commit/);
  assert.deepEqual(remoteBranches(fx), []);
}));

test('passes the fetch unpack limits to git', () => withFixture(fx => {
  const fake = installFakeGit(fx);
  const argsLog = join(fx.root, 'args.log');
  const result = publish(fx, fx.work, fx.bundle, { PATH: fakePath(fake), FAKE_ARG_LOG: argsLog });
  assert.equal(result.status, 0, result.stderr);
  const fetches = readFileSync(argsLog, 'utf8').trim().split('\n').filter(line => line.includes(' fetch '));
  assert.ok(fetches.length >= 2, `expected fetch invocations, got: ${fetches.join(' | ')}`);
  for (const line of fetches) {
    assert.match(line, /-c fetch\.unpackLimit=1/);
    assert.match(line, /-c transfer\.unpackLimit=1/);
  }
}));

test('fails when the target branch appears immediately before the push', () => withFixture(fx => {
  const fake = installFakeGit(fx);
  const marker = join(fx.root, 'race.marker');
  const result = publish(fx, fx.work, fx.bundle, {
    PATH: fakePath(fake), FAKE_RACE_REMOTE: fx.remote, FAKE_RACE_MARKER: marker,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /push failed/);
  assert.ok(remoteBranches(fx).every(line => line.endsWith(` ${fx.base}`)), 'an existing branch was moved or a new branch was pushed');
  assert.equal(git(fx.remote, 'rev-parse', 'refs/heads/main'), fx.base);
}));

test('keeps using the opened bundle when the original path is replaced by a symlink', () => withFixture(fx => {
  const mainTip = git(fx.work, 'rev-parse', 'HEAD');
  git(fx.work, 'checkout', '--quiet', '-b', 'other', fx.base);
  git(fx.work, 'commit', '--quiet', '--allow-empty', '-m', 'other tip');
  const otherTip = git(fx.work, 'rev-parse', 'HEAD');
  const otherBundle = join(fx.work, 'b.bundle');
  git(fx.work, 'bundle', 'create', otherBundle, `${fx.base}..HEAD`);
  git(fx.work, 'checkout', '--quiet', 'main');

  const firstBundle = join(fx.work, 'a.bundle');
  renameSync(fx.bundle, firstBundle);
  const link = join(fx.work, '.hiraishi-out.bundle');
  symlinkSync('a.bundle', link);

  const fake = installFakeGit(fx);
  const marker = join(fx.root, 'replace.marker');
  const result = publish(fx, fx.work, link, {
    PATH: fakePath(fake), FAKE_VERIFY_REPLACE: 'b.bundle', FAKE_VERIFY_PATH: link, FAKE_MARKER: marker,
  });
  assert.equal(result.status, 0, result.stderr);
  const published = output(result.stdout);
  assert.equal(published.tip, mainTip);
  assert.notEqual(published.tip, otherTip);
  assert.equal(readlinkSync(link), 'b.bundle');
  assert.equal(git(fx.remote, 'rev-parse', `refs/heads/${published.branch}`), mainTip);
}));

test('still publishes after the work directory .git is deleted', () => withFixture(fx => {
  const tip = git(fx.work, 'rev-parse', 'HEAD');
  rmSync(join(fx.work, '.git'), { recursive: true, force: true });

  const result = publish(fx, fx.work, fx.bundle);
  assert.equal(result.status, 0, result.stderr);
  const published = output(result.stdout);
  assert.equal(published.tip, tip);
  assert.equal(git(fx.remote, 'rev-parse', `refs/heads/${published.branch}`), tip);
}));

test('refuses control characters in the work directory or bundle path', () => withFixture(fx => {
  const badWork = join(fx.root, 'bad\nwork');
  mkdirSync(badWork);
  const workResult = publish(fx, badWork, fx.bundle);
  assert.notEqual(workResult.status, 0);
  assert.match(workResult.stderr, /workdir contains control characters/);

  const badBundle = join(fx.work, 'bad\nbundle');
  const bundleResult = publish(fx, fx.work, badBundle);
  assert.notEqual(bundleResult.status, 0);
  assert.match(bundleResult.stderr, /bundle contains control characters/);
}));

test('refuses an empty, control-character or trailing-LF remote in the allowlist', () => withFixture(fx => {
  for (const remote of ['', `${fx.remote}\nattack`, `${fx.remote}\n`, 'git@example.com:repo\u0000x']) {
    writeAllowlist(fx.bin, [{ path: realpathSync(fx.work), remote }]);
    const result = publish(fx, fx.work, fx.bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid allowlist/);
  }
  assert.deepEqual(remoteBranches(fx), []);
}));

test('checks for commands before the timeout re-exec', () => withFixture(fx => {
  const minbin = join(fx.root, 'minbin');
  mkdirSync(minbin);
  for (const name of ['bash', 'node', 'git', 'realpath']) symlinkSync(commandPath(name), join(minbin, name));
  const result = publish(fx, fx.work, fx.bundle, { PATH: minbin });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required command is missing: timeout/);
  assert.deepEqual(remoteBranches(fx), []);
}));

test('does not write to HOME or XDG_STATE_HOME', () => withFixture(fx => {
  const result = publish(fx, fx.work, fx.bundle);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(fx.home), []);
  assert.equal(existsSync(join(fx.root, 'state')), false);
}));

test('shows git stderr only when HIRAISHI_PUBLISH_DEBUG is set', () => withFixture(fx => {
  const missing = join(fx.root, 'missing.git');
  writeAllowlist(fx.bin, [{ path: realpathSync(fx.work), remote: missing }]);
  const quiet = publish(fx, fx.work, fx.bundle);
  assert.notEqual(quiet.status, 0);
  assert.match(quiet.stderr, /could not fetch the default branch/);
  assert.doesNotMatch(quiet.stderr, /missing\.git/);
  const debug = publish(fx, fx.work, fx.bundle, { HIRAISHI_PUBLISH_DEBUG: '1' });
  assert.notEqual(debug.status, 0);
  assert.match(debug.stderr, /could not fetch the default branch/);
  assert.ok(debug.stderr.length > quiet.stderr.length);
}));

test('ignores the work directory .git config, hooks and alternates', () => withFixture(fx => {
  const attacker = join(fx.root, 'attacker.git');
  git(fx.root, 'init', '--quiet', '--bare', attacker);
  git(fx.work, 'config', 'remote.origin.url', attacker);
  git(fx.work, 'config', 'core.hooksPath', join(fx.work, '.git', 'hooks'));
  git(fx.work, 'config', 'protocol.file.allow', 'never');
  const hook = join(fx.work, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  writeFileSync(join(fx.work, '.git', 'objects', 'info', 'alternates'), `${join(attacker, 'objects')}\n`);

  const result = publish(fx, fx.work, fx.bundle);
  assert.equal(result.status, 0, result.stderr);
  const published = output(result.stdout);
  assert.equal(git(fx.remote, 'rev-parse', `refs/heads/${published.branch}`), published.tip);
  assert.equal(git(attacker, 'for-each-ref'), '');
}));
