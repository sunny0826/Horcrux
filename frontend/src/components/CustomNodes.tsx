import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Database, Filter, ArrowRight, Zap } from 'lucide-react';

type SyncIndicatorState = 'idle' | 'syncing' | 'success' | 'error';

const getSyncStateClassName = (data: unknown): string => {
  const state = (data as { syncState?: SyncIndicatorState } | null)?.syncState;
  return state ? String(state) : 'idle';
};

export const SourceNode = memo(({ data }: NodeProps) => {
  return (
    <div className="bg-[#0d0d0d] border border-border min-w-[160px] shadow-lg group hover:border-primary transition-all">
      <div className="bg-[#111] p-2 border-b border-border flex items-center justify-between">
        <Database className="w-3 h-3 text-primary" />
        <span className="text-[9px] font-bold uppercase tracking-widest text-[#666]">Source</span>
        <div className={`w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_5px_#00ff41] hx-sync-indicator ${getSyncStateClassName(data)}`}></div>
      </div>
      <div className="p-3 space-y-2">
        <div className="text-[10px] font-bold text-textMain">{data.label || 'DOCKER_HUB'}</div>
        <div className="text-[8px] text-[#444] font-mono truncate">{data.image || 'nginx:latest'}</div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="w-2 h-2 !bg-primary !border-none rounded-none rotate-45"
      />
    </div>
  );
});

export const TargetNode = memo(({ data }: NodeProps) => {
  return (
    <div className="bg-[#0d0d0d] border border-border min-w-[160px] shadow-lg group hover:border-primary transition-all">
      <div className="bg-[#111] p-2 border-b border-border flex items-center justify-between">
        <ArrowRight className="w-3 h-3 text-primary" />
        <span className="text-[9px] font-bold uppercase tracking-widest text-[#666]">Target</span>
        <div className={`w-1.5 h-1.5 rounded-full bg-dim shadow-[0_0_5px_#008f11] hx-sync-indicator ${getSyncStateClassName(data)}`}></div>
      </div>
      <div className="p-3 space-y-2">
        <div className="text-[10px] font-bold text-textMain">{data.label || 'ALIYUN_ACR'}</div>
        <div className="text-[8px] text-[#444] font-mono truncate">{data.image || 'cn-hangzhou.v2'}</div>
      </div>
      <Handle
        type="target"
        position={Position.Left}
        className="w-2 h-2 !bg-primary !border-none rounded-none rotate-45"
      />
    </div>
  );
});

export const ProcessorNode = memo(({ data }: NodeProps) => {
  return (
    <div className="bg-[#111] border border-primary/30 min-w-[160px] shadow-lg group hover:border-primary transition-all">
      <div className="bg-primary/5 p-2 border-b border-primary/20 flex items-center justify-between">
        <Filter className="w-3 h-3 text-primary" />
        <span className="text-[9px] font-bold uppercase tracking-widest text-primary/60">Processor</span>
        <Zap className="w-3 h-3 text-primary animate-pulse" />
      </div>
      <div className="p-3 space-y-2">
        <div className="text-[10px] font-bold text-primary">{data.label || 'MANIFEST_MERGE'}</div>
        <div className="text-[8px] text-dim font-mono">{data.desc || 'AMD64+ARM64'}</div>
      </div>
      <Handle
        type="target"
        position={Position.Left}
        className="w-2 h-2 !bg-primary !border-none rounded-none rotate-45"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="w-2 h-2 !bg-primary !border-none rounded-none rotate-45"
      />
    </div>
  );
});
