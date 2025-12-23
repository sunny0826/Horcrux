import { memo } from 'react';
import { Position, type NodeProps } from 'reactflow';
import { Database, Filter, ArrowRight, Zap, Archive } from 'lucide-react';
import { BaseNode } from './BaseNode';
import type { SyncIndicatorState } from '../types';

const getSyncState = (data: unknown): SyncIndicatorState | undefined => {
  return (data as { syncState?: SyncIndicatorState } | null)?.syncState;
};

export const SourceNode = memo(({ data }: NodeProps) => {
  const isArchive = !!data.archiveRef;
  return (
    <BaseNode
      title={isArchive ? "Archive" : "Source"}
      icon={isArchive ? <Archive className="w-3.5 h-3.5 text-dim" /> : <Database className="w-3.5 h-3.5 text-primary" />}
      label={data.label || (isArchive ? 'LOCAL_ARCHIVE' : 'DOCKER_HUB')}
      subLabel={data.displayImage || data.image || (isArchive ? 'No archive selected' : 'nginx:latest')}
      syncState={getSyncState(data)}
      indicatorColor={isArchive ? "bg-dim shadow-[0_0_5px_var(--dim-green)]" : "bg-primary shadow-[0_0_5px_var(--primary-green)]"}
      variant="default"
      handles={[{ type: 'source', position: Position.Right }]}
    />
  );
});

export const TargetNode = memo(({ data }: NodeProps) => {
  return (
    <BaseNode
      title="Target"
      icon={<ArrowRight className="w-3.5 h-3.5 text-primary" />}
      label={data.label || 'ALIYUN_ACR'}
      subLabel={data.image || 'cn-hangzhou.v2'}
      syncState={getSyncState(data)}
      indicatorColor="bg-dim shadow-[0_0_5px_var(--dim-green)]"
      variant="default"
      handles={[{ type: 'target', position: Position.Left }]}
    />
  );
});

export const ProcessorNode = memo(({ data }: NodeProps) => {
  return (
    <BaseNode
      title="Processor"
      icon={<Filter className="w-3.5 h-3.5 text-primary" />}
      label={data.label || 'MANIFEST_MERGE'}
      subLabel={data.desc || 'AMD64+ARM64'}
      variant="processor"
      headerRight={<Zap className="w-3.5 h-3.5 text-primary animate-pulse" />}
      handles={[
        { type: 'target', position: Position.Left },
        { type: 'source', position: Position.Right }
      ]}
    />
  );
});
