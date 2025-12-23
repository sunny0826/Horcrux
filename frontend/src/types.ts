import type { Node, Edge } from 'reactflow';

export interface Credential {
  id: string;
  name: string;
  registry: string;
}

export type NodeDraft = {
  label: string;
  image: string;
  credId: string;
  params: string;
  archiveRef?: string;
  displayImage?: string;
};

export type TargetRuntimeState = {
  targetRef: string;
  targetId?: string;
  status: string;
  progress: number;
  attempts: number;
  error?: string;
};

export type TaskEvent =
  | {
      type: 'task_update';
      task_id: string;
      status?: string;
      cancel_requested?: boolean;
    }
  | {
      type: 'target_update';
      task_id: string;
      target_ref?: string;
      target_status?: string;
      progress?: number;
      attempts?: number;
      error?: string;
    };

export type PipeMeta = {
  id: string;
  name: string;
  description?: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export type PipeDTO = PipeMeta & {
  nodes: Node[];
  edges: Edge[];
};

export type PipeVersion = {
  version: number;
  updated_at: string;
};

export type PipeOp = {
  ts: string;
  kind: string;
  data?: unknown;
};

export type LoadedArchive = {
  id: string;
  name: string;
  size: number;
  created_at: string;
  ref: string;
  architecture?: string;
  os?: string;
  tag?: string;
  digest?: string;
};

export type SyncIndicatorState = 'idle' | 'syncing' | 'success' | 'error';

export type LatestTask = {
  id: string;
  source_ref: string;
  target_ref: string;
  status: string;
  name?: string;
};

export type Stats = {
  active_threads: number;
  total_data_size: string;
  total_tasks: number;
  auth_keys: number;
};
