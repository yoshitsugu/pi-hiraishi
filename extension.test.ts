import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import hiraishi from './hiraishi.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function harness() {
  const handlers = new Map<string, any>(); const tools = new Map<string, any>(); const commands = new Map<string, any>();
  const notices: string[] = [];
  const pi = {
    on: (name: string, callback: unknown) => { handlers.set(name, callback); },
    registerTool: (tool: any) => { tools.set(tool.name, { ...tool, sourceInfo: { source:'extension', path: new URL('./hiraishi.ts',import.meta.url).pathname } }); },
    getAllTools: () => [...tools.values()], registerCommand: (name: string, command: any) => { commands.set(name, command); },
  } as unknown as ExtensionAPI;
  const ctx: any = { cwd: process.cwd(), ui: { setStatus() {}, notify: (text:string) => notices.push(text) } };
  hiraishi(pi);
  return { handlers, tools, commands, notices, ctx };
}
test('extension replaces all basic tools and exposes network changes only as a human command', () => {
  const h=harness();
  assert.deepEqual([...h.tools.keys()],['read','write','edit','bash','hiraishi_subagent']);
  assert(h.commands.has('hiraishi-network'));
  assert(!h.tools.has('hiraishi_review'));
  assert(!h.tools.has('hiraishi-network'));
  for(const event of ['session_before_switch','session_before_fork','session_before_tree','session_shutdown','session_start','session_tree','user_bash']) assert(h.handlers.has(event));
});
test('missing session blocks custom tools and direct basic tool calls, including user shell', async () => {
  const h=harness();
  assert(h.handlers.get('tool_call')({toolName:'custom'},h.ctx).block);
  await assert.rejects(h.tools.get('read').execute('r',{path:'/etc/passwd'},undefined,undefined,h.ctx),/not started/);
  const shell=h.handlers.get('user_bash')({},h.ctx);
  await assert.rejects(shell.operations.exec('touch bypass',process.cwd(),{onData(){}}),/not started/);
});
test('legacy config fails visibly and never restores native file tools', async () => {
  const root=mkdtempSync('/tmp/hiraishi-extension-');const old=process.env.HIRAISHI_CONFIG;
  process.env.HIRAISHI_CONFIG=`${root}/config`;writeFileSync(process.env.HIRAISHI_CONFIG,'{"endpoint":"https://old-classifier","model":"old"}');
  try {
    const h=harness();await h.handlers.get('session_start')({},h.ctx);
    assert(h.notices.some(s=>s.includes('old classifier settings')));
    assert(h.handlers.get('tool_call')({toolName:'read'},h.ctx).block);
    await assert.rejects(h.tools.get('write').execute('w',{path:`${root}/bypass`,content:'x'},undefined,undefined,h.ctx));
    await h.handlers.get('session_shutdown')();
  }finally{if(old===undefined)delete process.env.HIRAISHI_CONFIG;else process.env.HIRAISHI_CONFIG=old;rmSync(root,{recursive:true,force:true});}
});
