import type { BashOperations, ReadOperations, WriteOperations, EditOperations } from '@earendil-works/pi-coding-agent';
import { NETWORK_DENIAL_GUIDANCE } from './policy.ts';
import type { FileOperation } from './protocol.ts';
import type { SandboxSession } from './session.ts';

export function createOperations(session: SandboxSession, signal?: AbortSignal) {
  const epoch = session.epoch;
  const file = async (op: FileOperation, path: string, content?: string) => {
    session.assertEpoch(epoch);
    if (content !== undefined && Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB');
    const result = await session.request({ op, path, ...(content !== undefined ? { content: Buffer.from(content).toString('base64') } : {}) }, { signal });
    return Buffer.from(result.data ?? '', 'base64');
  };
  const readFile = (path: string) => file('read', path);
  const writeFile = async (path: string, content: string) => { await file('write', path, content); };
  const read: ReadOperations = { readFile, access: async path => { await file('access-read', path); }, detectImageMimeType: async path => {
    const b = await file('sample', path);
    if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
    if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
    if (['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return undefined;
  } };
  const write: WriteOperations = { writeFile, mkdir: async path => { await file('mkdir', path); } };
  const edit: EditOperations = { readFile, writeFile, access: async path => { await file('access-edit', path); } };
  const bash: BashOperations = { exec: async (command, cwd, options) => {
    session.assertEpoch(epoch);
    if (cwd !== session.cwd) throw new Error('Working directory changed; start a new Hiraishi session');
    const result = await session.request({ op: 'bash', command, timeout: options.timeout }, { signal: options.signal ?? signal, onData: options.onData });
    if (result.networkDenied) options.onData(Buffer.from(`\n[Hiraishi: network access was refused while this command was running.] ${NETWORK_DENIAL_GUIDANCE}\n`));
    return { exitCode: result.exitCode ?? 1 };
  } };
  return { read, write, edit, bash };
}
