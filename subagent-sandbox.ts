import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { validateConfig, validateWorkspace, type Config } from './policy.ts';
import { SandboxSession } from './session.ts';

export type SubagentPermissions = Pick<Config, 'networkMode' | 'readOnly' | 'readWrite'> & {
  denyRead?: string[];
  workspace?: string;
};
export type OpenSubagentSandbox = (ctx: ExtensionToolContext, permissions: SubagentPermissions, signal: AbortSignal, workspaceCwd?: string) => Promise<{
  executeTool: ExtensionToolContext['executeTool'];
  close(): Promise<void>;
}>;

export class SubagentSandboxes {
  private scope = new AsyncLocalStorage<SandboxSession>();
  private children = new Set<SandboxSession>();
  private create: (parent: SandboxSession, config: Config, cwd: string) => SandboxSession;
  constructor(create = (parent: SandboxSession, config: Config, cwd: string) => new SandboxSession(cwd, parent.configPath, config, parent.agentDir, true)) {
    this.create = create;
  }

  current(parent: SandboxSession) {
    const child = this.scope.getStore();
    if (!child) return parent;
    if (child.status !== 'ready') throw new Error('Subagent sandbox is unavailable');
    return child;
  }

  async open(parent: SandboxSession, ctx: ExtensionToolContext, permissions: SubagentPermissions, signal: AbortSignal, workspaceCwd?: string) {
    const { workspace, denyRead, ...grants } = permissions;
    if (denyRead !== undefined && !Array.isArray(denyRead)) throw new Error('Invalid denyRead: expected an array');
    const cwd = workspaceCwd ?? (workspace === undefined ? parent.cwd : validateWorkspace(workspace, parent.cwd));
    const config = validateConfig({ ...grants, maxNetworkMode: grants.networkMode, denyRead: [...parent.config.denyRead, ...(denyRead ?? [])], socatPath: parent.config.socatPath });
    const child = this.create(parent, config, cwd);
    this.children.add(child);
    const close = async () => {
      signal.removeEventListener('abort', cancel);
      await child.stop();
      this.children.delete(child);
    };
    const cancel = () => { void child.stop().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) throw new Error('Subagent cancelled');
      await child.start();
      if (signal.aborted) throw new Error('Subagent cancelled');
      return {
        executeTool: ((name, args, options) => this.scope.run(child, () => ctx.executeTool(name, args, options))) as ExtensionToolContext['executeTool'],
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  }

  async stop() {
    const results = await Promise.allSettled([...this.children].map(async child => {
      await child.stop();
      this.children.delete(child);
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
