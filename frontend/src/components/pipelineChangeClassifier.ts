import type { EdgeChange, NodeChange } from 'reactflow';

export type ClassifiedPipeOp = {
  kind: string;
  data: unknown;
};

export function classifyNodeChanges(changes: NodeChange[]): { touched: boolean; ops: ClassifiedPipeOp[] } {
  let touched = false;
  const ops: ClassifiedPipeOp[] = [];

  for (const c of changes) {
    if (c.type === 'select') continue;
    if (c.type === 'position' && 'dragging' in c && c.dragging) continue;
    touched = true;

    if (c.type === 'add') ops.push({ kind: 'node:add', data: c });
    else if (c.type === 'remove') ops.push({ kind: 'node:remove', data: c });
    else if (c.type === 'position') ops.push({ kind: 'node:move', data: c });
    else ops.push({ kind: `node:${c.type}`, data: c });
  }

  return { touched, ops };
}

export function classifyEdgeChanges(changes: EdgeChange[]): { touched: boolean; ops: ClassifiedPipeOp[] } {
  let touched = false;
  const ops: ClassifiedPipeOp[] = [];

  for (const c of changes) {
    if (c.type === 'select') continue;
    touched = true;

    if (c.type === 'remove') ops.push({ kind: 'edge:remove', data: c });
    else ops.push({ kind: `edge:${c.type}`, data: c });
  }

  return { touched, ops };
}

