import type { Config, NetworkMode } from './policy.ts';
export interface RunnerInit { cwd: string; configPath: string; config: Config; mode: NetworkMode; runtimeRoot: string; temp: string; home: string; agentDir: string; delegated?: boolean }
export type FileOperation = 'read' | 'sample' | 'write' | 'mkdir' | 'access-read' | 'access-edit';
export type FileRequest = { op: FileOperation; path: string; content?: string };
export type Request = { id: number; op: 'bash'; command: string; timeout?: number } |
  ({ id: number } & FileRequest) |
  { id: number; op: 'cancel'; target: number } | { id: number; op: 'shutdown' };
export type Response = { type: 'spawned'; id: number; pid: number } | { type: 'reaped'; id: number } | { type: 'ready' } | { type: 'fatal'; error: string } | { type: 'data'; id: number; data: string } |
  { type: 'result'; id: number; exitCode?: number; data?: string; error?: string; networkDenied?: boolean };
