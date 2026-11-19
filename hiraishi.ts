import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition, getAgentDir,
  type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { canonicalPath, ceilingOf, ceilingViolations, isNetworkMode, loadConfig, mergeGrants, NETWORK_DENIAL_GUIDANCE, parseGrants, restrictGrants, type Config, type NetworkMode } from './policy.ts';
import { SandboxSession } from './session.ts';
import { createOperations } from './tools.ts';
import { installSubagent } from './subagent.ts';
import { installHostBridge, HOST_TOOL } from './host-bridge.ts';
import { SubagentSandboxes } from './subagent-sandbox.ts';
import { installFooter } from './footer.ts';

export default function hiraishi(pi: ExtensionAPI) {
  const configPath = resolve(process.env.HIRAISHI_CONFIG ?? join(getAgentDir(), 'hiraishi', 'config.json'));
  let session: SandboxSession | undefined;
  let error = 'Hiraishi session has not started';
  let lifecycle = {};
  let retirement = Promise.resolve();
  let hostCommands: Config['hostCommands'] = [];
  let hostBaseline: Config | undefined;
  const children = new SubagentSandboxes();
  const sourcePath = fileURLToPath(import.meta.url);
  const schemas = new Map<string, object>();
  const owns = (name: string) => {
    const info = pi.getAllTools().find(tool => tool.name === name);
    return !!info && info.parameters === schemas.get(name) && info.sourceInfo.path === sourcePath;
  };
  const current = (ctx: ExtensionContext) => {
    if (!session || session.status !== 'ready') throw new Error(session ? `Hiraishi sandbox ${session.status}: ${session.failureReason}` : error);
    if (canonicalPath(ctx.cwd) !== session.cwd) throw new Error('Working directory changed; start a new session');
    return children.current(session);
  };
  const display = (ctx: ExtensionContext) => ctx.ui.setStatus('hiraishi', session?.status === 'ready' ? `🛡️[sandbox:on,network:${session.mode}${session.ceilingMode !== session.mode ? `/max:${session.ceilingMode}` : ''}]` : `🛡️[sandbox:${session?.status ?? 'unavailable'},network:unavailable]`);
  pi.registerFlag('hiraishi-grants', {
    type: 'string',
    description: `JSON session permissions granted by the caller, e.g. '{"networkMode":"http-get","maxNetworkMode":"http-get","readOnly":["/docs"],"replace":{"readOnly":["/docs"]},"denyRead":["/project/.env"]}'. Directory grants are additive; replace drops baseline directories explicitly; denyRead only grows; maxNetworkMode lowers the session ceiling. cwd pins the expected workspace and noHostCommands drops host commands for delegated work. Requests beyond maxNetworkMode ask the user in interactive sessions and refuse the session otherwise. The configuration's maxReadOnly and maxReadWrite raise the path ceiling without adding grants.`,
  });
  const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ch => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
  let refused = false;
  const resolveGrants = async (ctx: ExtensionContext, baseline: Config): Promise<Config> => {
    const raw = pi.getFlag('hiraishi-grants');
    if (typeof raw !== 'string' || !raw.trim()) return baseline;
    let grants;
    try { grants = parseGrants(raw); }
    catch (error) { refused = !ctx.hasUI; throw error; }
    if (grants.expectedCwd && grants.expectedCwd !== canonicalPath(ctx.cwd)) {
      refused = !ctx.hasUI;
      throw new Error(`Working directory changed since this child was launched: expected ${grants.expectedCwd}`);
    }
    const violations = ceilingViolations(grants, ceilingOf(baseline));
    if (!violations.length) return mergeGrants(baseline, grants);
    // A caller that cannot ask the user must not get a session at all.
    refused = true;
    if (!ctx.hasUI) throw new Error(`Requested Hiraishi permissions exceed the session ceiling and no interactive UI is available to approve them: ${violations.join('; ')}`);
    const requested = clean(raw.length > 1000 ? `${raw.slice(0, 1000)}…` : raw);
    const listed = violations.slice(0, 10).map(v => `- ${clean(v)}`).join('\n') + (violations.length > 10 ? `\n… ${violations.length - 10} more` : '');
    const choice = await ctx.ui.select(`Hiraishi permission request exceeds the session ceiling (maxNetworkMode: ${baseline.maxNetworkMode})\nRequested: ${requested}\nViolations:\n${listed}`,
      ['Allow requested permissions', 'Start with baseline permissions', 'Refuse to start']);
    if (choice === 'Allow requested permissions') return mergeGrants(baseline, grants);
    if (choice === 'Start with baseline permissions') return restrictGrants(baseline, grants);
    refused = true;
    throw new Error('Hiraishi permission request refused by the user');
  };
  const definitionFor = (name: string, active: SandboxSession, cwd: string, signal?: AbortSignal, onNetworkDenied?: () => void) => {
    const op = createOperations(active, signal, onNetworkDenied);
    switch (name) {
      case 'read': return createReadToolDefinition(cwd, { operations: op.read });
      case 'write': return createWriteToolDefinition(cwd, { operations: op.write });
      case 'edit': return createEditToolDefinition(cwd, { operations: op.edit });
      case 'bash': return createBashToolDefinition(cwd, { operations: op.bash, exposeSessionEnvironment: false });
      default: throw new Error(`Unsupported tool: ${name}`);
    }
  };
  const initial: ToolDefinition<any, any, any>[] = [createReadToolDefinition(process.cwd()), createWriteToolDefinition(process.cwd()), createEditToolDefinition(process.cwd()), createBashToolDefinition(process.cwd())];
  for (const definition of initial) {
    const parameters = { ...definition.parameters }; schemas.set(definition.name, parameters);
    pi.registerTool({ ...definition, parameters, ...(definition.name === 'bash' ? { promptGuidelines: [...(definition.promptGuidelines ?? []), NETWORK_DENIAL_GUIDANCE] } : {}), async execute(id, input, signal, onUpdate, ctx) {
      const active = current(ctx); const epoch = active.epoch;
      if (!owns(definition.name)) throw new Error('Hiraishi tool was replaced; execution refused');
      let networkDenied = false;
      const result = await definitionFor(definition.name, active, ctx.cwd, signal, () => { networkDenied = true; }).execute(id, input as never, signal, onUpdate as never, ctx);
      active.assertEpoch(epoch);
      if (active !== current(ctx)) throw new Error('Session changed; discard this result');
      return networkDenied ? { ...result, details: { ...result.details, networkDenied: true } } : result;
    } });
  }
  const subagent = installSubagent(pi, ctx => {
    const parent = current(ctx), epoch = parent.epoch;
    return () => parent === session && parent.status === 'ready' && parent.epoch === epoch;
  }, (ctx, permissions, signal) => children.open(current(ctx), ctx, permissions, signal),
  ctx => ceilingOf(current(ctx).config, current(ctx).cwd));
  const bridge = installHostBridge(pi, {
    hiraishiPath: sourcePath,
    commands: () => hostCommands ?? [],
    baseline: () => hostBaseline ?? loadConfig(configPath),
    scope: ctx => {
      const parent = current(ctx);
      return { ceiling: ceilingOf(parent.config, parent.cwd), writable: [parent.cwd, ...parent.config.readWrite], denyRead: parent.config.denyRead };
    },
  });
  pi.on('tool_call', (event, ctx) => {
    try {
      current(ctx);
      if (owns(event.toolName) || event.toolName === 'hiraishi_subagent' && subagent.owns(pi.getAllTools().find(tool => tool.name === event.toolName)) ||
          event.toolName === HOST_TOOL && bridge.owns(pi.getAllTools().find(tool => tool.name === event.toolName))) return;
      return { block: true, reason: `Hiraishi refuses unadapted tool ${event.toolName}. Use read, write, edit, bash, hiraishi_subagent or hiraishi_host.` };
    } catch (e) { return { block: true, reason: String((e as Error).message) }; }
  });
  pi.on('user_bash', (_event, ctx) => ({ operations: { exec: async (command, cwd, options) => {
    const active = current(ctx);
    return createOperations(active).bash.exec(command, cwd, options);
  } } }));
  const stop = () => {
    lifecycle = {};
    const active = session;
    session = undefined;
    error = 'Hiraishi session has ended';
    hostCommands = [];
    hostBaseline = undefined;
    bridge.reset();
    const ending = active?.stop();
    retirement = Promise.all([retirement, ending, children.stop()]).then(() => {});
    // Keep failed cleanup observable to subsequent starts even when pi catches hook errors.
    void retirement.catch(() => {});
    return retirement;
  };
  pi.on('session_before_switch', stop);
  pi.on('session_before_fork', stop);
  pi.on('session_before_tree', stop);
  pi.on('session_shutdown', stop);
  const start = async (ctx: ExtensionContext) => {
    installFooter(pi, ctx);
    refused = false;
    const token = lifecycle;
    try {
      await retirement;
      if (token !== lifecycle) return;
      if (session) throw new Error('A Hiraishi session is already active');
      const baseline = loadConfig(configPath);
      hostBaseline = baseline;
      const config = await resolveGrants(ctx, baseline);
      hostCommands = config.hostCommands ?? [];
      const active = new SandboxSession(canonicalPath(ctx.cwd), configPath, config, getAgentDir());
      session = active;
      await active.start();
    } catch (e) {
      if (token !== lifecycle) return;
      error = String((e as Error).message);
      ctx.ui.notify(`Hiraishi unavailable: ${error}`, 'error');
      if (refused && !ctx.hasUI) {
        // Only a refused permission request ends the process; other startup failures keep the session with tools unavailable.
        console.error(`Hiraishi unavailable: ${error}`);
        ctx.shutdown();
        return;
      }
    }
    if (token === lifecycle) display(ctx);
  };
  pi.on('session_start', (_event, ctx) => start(ctx));
  pi.on('session_tree', (_event, ctx) => start(ctx));
  pi.registerCommand('hiraishi-network', {
    description: 'Show or change this session network mode: off, http-get, http-all. Changing stops running tools. Human command only.',
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (!mode) { ctx.ui.notify(`Hiraishi: ${session?.status ?? 'unavailable'} · ${session?.mode ?? 'off'}. Usage: /hiraishi-network off|http-get|http-all`, 'info'); return; }
      if (!isNetworkMode(mode)) { ctx.ui.notify('Choose off, http-get, or http-all.', 'error'); return; }
      const token = lifecycle;
      try {
        const active = current(ctx);
        if (mode === active.mode) { display(ctx); return; }
        ctx.ui.notify('Changing network mode stops running tools and downloads. Completed external effects cannot be undone.', 'warning');
        await children.stop();
        await active.changeMode(mode as NetworkMode);
      } catch (e) { if (token === lifecycle) ctx.ui.notify(`Hiraishi: ${(e as Error).message}`, 'error'); }
      if (token === lifecycle) display(ctx);
    },
  });
}
