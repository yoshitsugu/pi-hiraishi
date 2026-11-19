import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import hiraishi from './hiraishi.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function harness(flags: Record<string, string | boolean> = {}) {
  const handlers = new Map<string, any>(); const tools = new Map<string, any>(); const commands = new Map<string, any>(); const flagDefs = new Map<string, any>();
  const flagValues = new Map<string, string | boolean>(Object.entries(flags));
  const notices: string[] = [];
  const counters = { shutdowns: 0 };
  const pi = {
    on: (name: string, callback: unknown) => { handlers.set(name, callback); },
    registerTool: (tool: any) => { tools.set(tool.name, { ...tool, sourceInfo: { source:'extension', path: new URL('./hiraishi.ts',import.meta.url).pathname } }); },
    getAllTools: () => [...tools.values()], registerCommand: (name: string, command: any) => { commands.set(name, command); },
    registerFlag: (name: string, options: any) => { flagDefs.set(name, options); },
    getFlag: (name: string) => flagValues.get(name),
  } as unknown as ExtensionAPI;
  const ctx: any = { cwd: process.cwd(), hasUI: false, shutdown() { counters.shutdowns++; }, ui: { setStatus() {}, notify: (text:string) => notices.push(text), select: async () => undefined } };
  hiraishi(pi);
  return { handlers, tools, commands, notices, ctx, flagDefs, flagValues, counters };
}
test('extension replaces all basic tools and exposes network changes only as a human command', () => {
  const h=harness();
  assert.deepEqual([...h.tools.keys()],['read','write','edit','bash','hiraishi_subagent','hiraishi_host']);
  assert(h.commands.has('hiraishi-network'));
  const guidance=h.tools.get('bash').promptGuidelines.join(' ');
  assert.match(guidance,/pause the affected work/);
  assert.match(guidance,/continue offline/);
  assert.match(guidance,/Wait for their answer/);
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
test('CLI grants add to the baseline, respect maxNetworkMode, and ask only when UI is available', async () => {
  const root=mkdtempSync('/tmp/hiraishi-grants-ext-');mkdirSync(`${root}/docs/sub`,{recursive:true});
  const old=process.env.HIRAISHI_CONFIG;process.env.HIRAISHI_CONFIG=`${root}/config`;
  writeFileSync(process.env.HIRAISHI_CONFIG,JSON.stringify({ networkMode: 'off', maxNetworkMode: 'http-get', readOnly: [`${root}/docs`] }));
  const asked: string[] = [];
  try {
    const h0=harness();assert(h0.flagDefs.has('hiraishi-grants'));
    let h=harness({ 'hiraishi-grants': JSON.stringify({ networkMode: 'http-all' }) });
    h.ctx.hasUI=true;h.ctx.ui.select=async (title:string)=>{asked.push(title);return 'Refuse to start';};
    await h.handlers.get('session_start')({},h.ctx);
    assert.equal(asked.length,1);assert.match(asked[0]!,/session ceiling/);assert.match(asked[0]!,/http-all exceeds the session ceiling http-get/);
    assert(h.notices.some(s=>s.includes('refused')));
    assert.equal(h.counters.shutdowns,0);
    await h.handlers.get('session_shutdown')();

    const errors: string[] = [];const original=console.error;console.error=(...args:unknown[])=>{errors.push(args.join(' '));};
    try {
      h=harness({ 'hiraishi-grants': JSON.stringify({ networkMode: 'http-all' }) });
      h.ctx.hasUI=false;
      await h.handlers.get('session_start')({},h.ctx);
      assert.equal(h.counters.shutdowns,1);
      assert.equal(errors.length,1);assert.match(errors[0]!,/session ceiling/);
      await h.handlers.get('session_shutdown')();
      h=harness({ 'hiraishi-grants': 'not json' });
      h.ctx.hasUI=false;
      await h.handlers.get('session_start')({},h.ctx);
      assert.equal(h.counters.shutdowns,1);
      assert(errors.some(text=>/not valid JSON/.test(text)));
      h=harness({ 'hiraishi-grants': JSON.stringify({ cwd: '/tmp' }) });
      h.ctx.hasUI=false;
      await h.handlers.get('session_start')({},h.ctx);
      assert.equal(h.counters.shutdowns,1);
      assert(errors.some(text=>/Working directory changed since this child was launched/.test(text)));
      writeFileSync(process.env.HIRAISHI_CONFIG!,'{"endpoint":"https://old-classifier"}');
      h=harness();
      await h.handlers.get('session_start')({},h.ctx);
      assert.equal(h.counters.shutdowns,0);
      await h.handlers.get('session_shutdown')();
    } finally { console.error=original; }
    writeFileSync(process.env.HIRAISHI_CONFIG,JSON.stringify({ networkMode: 'off', maxNetworkMode: 'http-get', readOnly: [`${root}/docs`] }));
    h=harness({ 'hiraishi-grants': JSON.stringify({ readOnly: [`${root}/docs/sub`], denyRead: [`${root}/docs/secret`] }) });
    await h.handlers.get('session_start')({},h.ctx);
    assert(!h.notices.some(s=>s.includes('exceed the session ceiling')));
    await h.handlers.get('session_shutdown')();

    h=harness({ 'hiraishi-grants': JSON.stringify({ networkMode: 'http-get' }) });
    asked.length=0;h.ctx.hasUI=true;h.ctx.ui.select=async (title:string)=>{asked.push(title);return 'Allow requested permissions';};
    await h.handlers.get('session_start')({},h.ctx);
    assert.equal(asked.length,0);assert(!h.notices.some(s=>s.includes('exceed the session ceiling')));
    await h.handlers.get('session_shutdown')();

    h=harness({ 'hiraishi-grants': JSON.stringify({ networkMode: 'http-all' }) });
    h.ctx.hasUI=true;h.ctx.ui.select=async ()=> 'Start with baseline permissions';
    await h.handlers.get('session_start')({},h.ctx);
    assert(!h.notices.some(s=>s.includes('exceed the session ceiling')));
    await h.handlers.get('session_shutdown')();

    h=harness({ 'hiraishi-grants': JSON.stringify({ networkMode: 'http-all' }) });
    h.ctx.hasUI=true;h.ctx.ui.select=async ()=> undefined;
    await h.handlers.get('session_start')({},h.ctx);
    assert(h.notices.some(s=>s.includes('refused')));
    await h.handlers.get('session_shutdown')();
  }finally{if(old===undefined)delete process.env.HIRAISHI_CONFIG;else process.env.HIRAISHI_CONFIG=old;rmSync(root,{recursive:true,force:true});}
});

test('configured path ceilings accept grants without a permission dialog', async () => {
  const root=mkdtempSync('/tmp/hiraishi-path-ceiling-ext-');
  for(const dir of ['docs','extra','cache'])mkdirSync(`${root}/${dir}`,{recursive:true});
  const old=process.env.HIRAISHI_CONFIG;process.env.HIRAISHI_CONFIG=`${root}/config`;
  writeFileSync(process.env.HIRAISHI_CONFIG,JSON.stringify({ readOnly: [`${root}/docs`], maxReadOnly: [`${root}/extra`], maxReadWrite: [`${root}/cache`] }));
  const asked: string[] = [];
  try {
    const h=harness({ 'hiraishi-grants': JSON.stringify({ readOnly: [`${root}/extra`], readWrite: [`${root}/cache`] }) });
    h.ctx.hasUI=true;h.ctx.ui.select=async (title:string)=>{asked.push(title);return 'Refuse to start';};
    await h.handlers.get('session_start')({},h.ctx);
    assert.equal(asked.length,0);
    assert(!h.notices.some(s=>s.includes('exceed the session ceiling')));
    await h.handlers.get('session_shutdown')();

    const outside=harness({ 'hiraishi-grants': JSON.stringify({ readWrite: [`${root}/outside`] }) });
    outside.ctx.hasUI=true;outside.ctx.ui.select=async (title:string)=>{asked.push(title);return 'Refuse to start';};
    await outside.handlers.get('session_start')({},outside.ctx);
    assert.equal(asked.length,1);
    assert.match(asked[0]!,/session ceiling/);
    await outside.handlers.get('session_shutdown')();
  }finally{if(old===undefined)delete process.env.HIRAISHI_CONFIG;else process.env.HIRAISHI_CONFIG=old;rmSync(root,{recursive:true,force:true});}
});
