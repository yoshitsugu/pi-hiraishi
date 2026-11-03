import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, SessionEntry, Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import { alignFooterRow, installFooter } from './footer.ts';

test('directory row right-aligns status and truncates paths at terminal columns', () => {
  const status = '🛡️[sandbox:on,network:http-get]';
  for (const path of ['~/junk/2026/11/03', '~/作業/長いディレクトリ名'.repeat(8), '\x1b[2m~/作業\x1b[0m']) {
    for (const width of [visibleWidth(status), 40, 80, 140]) {
      const row = alignFooterRow(path, status, width);
      assert.equal(visibleWidth(row), width);
      assert(stripTerminalSequences(row).endsWith(status));
    }
  }
  for (const width of [0, 1, 2, 10]) assert(visibleWidth(alignFooterRow('~/work', status, width)) <= width);
});

function fixture() {
  let component: (Component & { dispose?(): void }) | undefined;
  let branchChanged: (() => void) | undefined;
  let renders = 0, disposed = false, auto = true;
  let entries: SessionEntry[] = [];
  const statuses = new Map([['hiraishi', '🛡️[sandbox:on,network:off]']]);
  const footerData: ReadonlyFooterDataProvider = {
    getGitBranch: () => 'main', getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => statuses,
    onBranchChange: callback => { branchChanged = callback; return () => { disposed = true; }; },
  };
  const ctx = {
    mode: 'tui', cwd: `${homedir()}/junk/2026/11/03`,
    ui: { setFooter: (factory: Parameters<ExtensionContext['ui']['setFooter']>[0]) => { if (factory) component = factory({ requestRender: () => { renders++; } } as unknown as TUI, { fg: (_color, text) => text } as Theme, footerData); } },
    sessionManager: { getSessionId: () => 'session', getLeafId: () => null, getEntries: () => entries, getSessionName: () => 'session name' },
    model: { id: 'mistral-large-4', provider: 'mistral', reasoning: true, contextWindow: 1000000 },
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => ({ percent: 8.4, contextWindow: 1000000 }),
  } as unknown as ExtensionContext;
  const pi = { getSettings: () => ({ compaction: { enabled: auto } }), getThinkingLevel: () => 'high' } as ExtensionAPI;
  return { ctx, pi, statuses, setEntries: (value: SessionEntry[]) => { entries = value; }, setAuto: (value: boolean) => { auto = value; },
    render: (width = 140) => component!.render(width), branchChanged: () => branchChanged!(),
    renders: () => renders, dispose: () => component!.dispose!(), disposed: () => disposed };
}

test('footer places live sandbox status beside directory and retains other extension statuses', () => {
  const f = fixture();
  installFooter(f.pi, f.ctx);
  let lines = f.render();
  assert.equal(lines.length, 2);
  assert(lines[0].startsWith('~/junk/2026/11/03 (main) • session name'));
  assert(lines[0].endsWith('🛡️[sandbox:on,network:off]'));
  assert(lines[1].includes('8.4%/1.0M (auto)'));
  assert(lines[1].endsWith('(mistral) mistral-large-4 • high'));
  f.statuses.set('hiraishi', '🛡️[sandbox:on,network:http-get]');
  f.statuses.set('z', 'last\nstatus');
  f.statuses.set('a', 'first status');
  lines = f.render();
  assert(lines[0].endsWith('🛡️[sandbox:on,network:http-get]'));
  assert.equal(lines[2], 'first status last status');
  for (const width of [1, 10, 40, 80]) {
    for (const line of f.render(width)) assert(visibleWidth(line) <= width);
  }
  f.branchChanged();
  assert.equal(f.renders(), 1);
  f.dispose();
  assert(f.disposed());
});

test('usage totals update after appends and include compaction and auxiliary usage', () => {
  const f = fixture();
  installFooter(f.pi, f.ctx);
  assert(!f.render()[1].includes('↑'));
  const usage = { input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0, totalTokens: 10100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } };
  f.setEntries([
    { type: 'message', message: { role: 'assistant', usage } },
    { type: 'compaction', usage },
    { type: 'usage', usage },
    { type: 'branch_summary', usage },
    { type: 'message', message: { role: 'toolResult', usage } },
  ] as SessionEntry[]);
  assert.match(f.render()[1], /↑5.0k ↓500 R45k CH90.0% \$0.500/);
  f.setAuto(false);
  assert(!f.render()[1].includes('(auto)'));
});

test('non-terminal modes retain native status reporting', () => {
  for (const mode of ['rpc', 'print', 'json'] as const) {
    installFooter({} as ExtensionAPI, { mode, ui: { setFooter() { assert.fail('custom footer outside TUI'); } } } as unknown as ExtensionContext);
  }
});
