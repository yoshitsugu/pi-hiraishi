import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

function formatTokens(count: number) {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function singleLine(text: string) {
  return text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();
}

export function alignFooterRow(left: string, right: string, width: number) {
  if (width <= 0) return '';
  const end = truncateToWidth(right, width, '');
  const endWidth = visibleWidth(end);
  const start = truncateToWidth(left, Math.max(0, width - endWidth - 2), '…');
  return start + ' '.repeat(Math.max(0, width - visibleWidth(start) - endWidth)) + end;
}

function summarizeUsage(entries: SessionEntry[]) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHitRate: number | undefined;
  for (const entry of entries) {
    const usage = entry.type === 'usage' ? entry.usage
      : entry.type === 'message' && (entry.message.role === 'assistant' || entry.message.role === 'toolResult') ? entry.message.usage
      : entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.usage : undefined;
    if (!usage) continue;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      cacheHitRate = prompt > 0 ? usage.cacheRead / prompt * 100 : undefined;
    }
  }
  return { ...totals, cacheHitRate };
}

export function installFooter(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (ctx.mode !== 'tui') return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    let cached: { sessionId: string; leafId: string | null; count: number; totals: ReturnType<typeof summarizeUsage> } | undefined;
    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width) {
        const manager = ctx.sessionManager;
        const entries = manager.getEntries();
        const sessionId = manager.getSessionId(), leafId = manager.getLeafId(), count = entries.length;
        if (!cached || cached.sessionId !== sessionId || cached.leafId !== leafId || cached.count !== count) {
          cached = { sessionId, leafId, count, totals: summarizeUsage(entries) };
        }
        const usage = cached.totals;
        const homeRelative = relative(homedir(), ctx.cwd);
        let directory = homeRelative === '' ? '~'
          : homeRelative !== '..' && !homeRelative.startsWith(`..${sep}`) && !isAbsolute(homeRelative) ? `~${sep}${homeRelative}` : ctx.cwd;
        const branch = footerData.getGitBranch(), name = manager.getSessionName();
        if (branch) directory += ` (${branch})`;
        if (name) directory += ` • ${name}`;
        const statuses = footerData.getExtensionStatuses();
        const status = statuses.get('hiraishi');
        const directoryLine = status
          ? alignFooterRow(theme.fg('dim', singleLine(directory)), singleLine(status), width)
          : truncateToWidth(theme.fg('dim', singleLine(directory)), width);

        const parts: string[] = [];
        if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
        if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
        if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
        if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
        if ((usage.cacheRead || usage.cacheWrite) && usage.cacheHitRate !== undefined) parts.push(`CH${usage.cacheHitRate.toFixed(1)}%`);
        const model = ctx.model;
        const subscription = model && (model.provider === 'kimi-coding'
          || ctx.modelRegistry.isUsingOAuth(model) && ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true);
        if (usage.cost || subscription) parts.push(`$${usage.cost.toFixed(3)}${subscription ? ' (sub)' : ''}`);
        const context = ctx.getContextUsage();
        const percent = context?.percent;
        const auto = pi.getSettings().compaction?.enabled !== false ? ' (auto)' : '';
        const contextText = `${percent === null ? '?' : `${(percent ?? 0).toFixed(1)}%`}/${formatTokens(context?.contextWindow ?? model?.contextWindow ?? 0)}${auto}`;
        parts.push(theme.fg((percent ?? 0) > 90 ? 'error' : (percent ?? 0) > 70 ? 'warning' : 'dim', contextText));
        let modelText = model?.id ?? 'no-model';
        if (model?.reasoning) {
          const thinking = pi.getThinkingLevel();
          modelText += ` • ${thinking === 'off' ? 'thinking off' : thinking}`;
        }
        const stats = parts.join(' ');
        if (model && footerData.getAvailableProviderCount() > 1 && visibleWidth(stats) + visibleWidth(modelText) + model.provider.length + 5 <= width) {
          modelText = `(${model.provider}) ${modelText}`;
        }
        const left = truncateToWidth(stats, width, '...');
        const right = truncateToWidth(singleLine(modelText), Math.max(0, width - visibleWidth(left) - 2), '');
        const lines = [directoryLine, theme.fg('dim', left) + ' '.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right))) + theme.fg('dim', right)];
        const others = [...statuses].filter(([key]) => key !== 'hiraishi').sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => singleLine(text));
        if (others.length) lines.push(truncateToWidth(others.join(' '), width));
        return lines;
      },
    };
  });
}
