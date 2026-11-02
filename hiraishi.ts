import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition, getAgentDir,
  type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { isNetworkMode, loadConfig, NETWORK_DENIAL_GUIDANCE, type NetworkMode } from './policy.ts';
import { SandboxSession } from './session.ts';
import { createOperations } from './tools.ts';
import { installSubagent } from './subagent.ts';

export default function hiraishi(pi: ExtensionAPI) {
  const configPath = resolve(process.env.HIRAISHI_CONFIG ?? join(getAgentDir(), 'hiraishi', 'config.json'));
  let session: SandboxSession | undefined;
  let error = 'Hiraishi session has not started';
  let lifecycle = {};
  let retirement = Promise.resolve();
  const sourcePath = fileURLToPath(import.meta.url);
  const schemas = new Map<string, object>();
  const owns = (name: string) => {
    const info = pi.getAllTools().find(tool => tool.name === name);
    return !!info && info.parameters === schemas.get(name) && info.sourceInfo.path === sourcePath;
  };
  const current = (ctx: ExtensionContext) => {
    if (!session || session.status !== 'ready') throw new Error(session ? `Hiraishi sandbox ${session.status}: ${session.failureReason}` : error);
    if (resolve(ctx.cwd) !== session.cwd) throw new Error('Working directory changed; start a new session');
    return session;
  };
  const display = (ctx: ExtensionContext) => ctx.ui.setStatus('hiraishi', session?.status === 'ready' ? `🛡️[sandbox:on,network:${session.mode}]` : `🛡️[sandbox:${session?.status ?? 'unavailable'},network:unavailable]`);
  const definitionFor = (name: string, active: SandboxSession, cwd: string, signal?: AbortSignal) => {
    const op = createOperations(active, signal);
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
      const result = await definitionFor(definition.name, active, ctx.cwd, signal).execute(id, input as never, signal, onUpdate as never, ctx);
      active.assertEpoch(epoch);
      if (active !== session) throw new Error('Session changed; discard this result');
      return result;
    } });
  }
  const subagent = installSubagent(pi, ctx => {
    const parent = current(ctx), epoch = parent.epoch;
    return () => parent === session && parent.status === 'ready' && parent.epoch === epoch;
  });
  pi.on('tool_call', (event, ctx) => {
    try {
      current(ctx);
      if (owns(event.toolName) || event.toolName === 'hiraishi_subagent' && subagent.owns(pi.getAllTools().find(tool => tool.name === event.toolName))) return;
      return { block: true, reason: `Hiraishi refuses unadapted tool ${event.toolName}. Use read, write, edit, bash, or hiraishi_subagent.` };
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
    if (active) {
      const ending = active.stop();
      retirement = Promise.all([retirement, ending]).then(() => {});
      // Keep failed cleanup observable to subsequent starts even when pi catches hook errors.
      void retirement.catch(() => {});
    }
    return retirement;
  };
  pi.on('session_before_switch', stop);
  pi.on('session_before_fork', stop);
  pi.on('session_before_tree', stop);
  pi.on('session_shutdown', stop);
  const start = async (ctx: ExtensionContext) => {
    const token = lifecycle;
    try {
      await retirement;
      if (token !== lifecycle) return;
      if (session) throw new Error('A Hiraishi session is already active');
      const active = new SandboxSession(resolve(ctx.cwd), configPath, loadConfig(configPath), getAgentDir());
      session = active;
      await active.start();
    } catch (e) {
      if (token !== lifecycle) return;
      error = String((e as Error).message);
      ctx.ui.notify(`Hiraishi unavailable: ${error}`, 'error');
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
        await active.changeMode(mode as NetworkMode);
      } catch (e) { if (token === lifecycle) ctx.ui.notify(`Hiraishi: ${(e as Error).message}`, 'error'); }
      if (token === lifecycle) display(ctx);
    },
  });
}
