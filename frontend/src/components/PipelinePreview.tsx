import { Loader2, Play } from 'lucide-react';
import { FlowPreview } from './FlowPreview';
import type { PipeMeta, PipeDTO } from '../types';
import { getPipeDisplayName, getPipeStatusLabel } from '../utils/pipeUtils';
import type { Node, Edge } from 'reactflow';

interface PipelinePreviewProps {
  pipes: PipeMeta[];
  activePipeIndex: number;
  pipesError: string | null;
  isPipesLoading: boolean;
  isPipeDetailLoading: boolean;
  activePipeDetail: PipeDTO | null;
  isPipePreviewVisible: boolean;
  openActivePipeInDesigner: () => void;
}

export function PipelinePreview({
  pipes,
  activePipeIndex,
  pipesError,
  isPipesLoading,
  isPipeDetailLoading,
  activePipeDetail,
  isPipePreviewVisible,
  openActivePipeInDesigner,
}: PipelinePreviewProps) {
  return (
    <div className="h-72 bg-background border border-border relative overflow-hidden">
      <div
        className={[
          'absolute inset-0',
          pipesError || isPipesLoading || pipes.length === 0
            ? 'flex items-center justify-center'
            : 'p-4 flex flex-col justify-between',
          'transition-[opacity,transform] duration-300 ease-out',
          isPipePreviewVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
        ].join(' ')}
      >
        {pipesError ? (
          <div className="text-[10px] text-textMain/60 uppercase tracking-widest">
            FAILED_TO_LOAD_PIPES: {pipesError}
          </div>
        ) : isPipesLoading ? (
          <div className="flex items-center space-x-2 text-[10px] text-textMain/60 uppercase tracking-widest">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>LOADING_PIPELINES</span>
          </div>
        ) : pipes.length === 0 ? (
          <div className="text-[10px] text-textMain/60 uppercase tracking-widest">
            NO_PIPELINES_FOUND
          </div>
        ) : (
          (() => {
            const activeMeta = pipes[activePipeIndex];
            return (
              <div className="w-full h-full relative group bg-background">
                <div className="absolute inset-0">
                  {isPipeDetailLoading ? (
                    <div className="w-full h-full flex items-center justify-center space-x-2 text-[10px] text-textMain/60 uppercase tracking-widest">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>LOADING_PREVIEW</span>
                    </div>
                  ) : (
                    <FlowPreview
                      nodes={activePipeDetail?.nodes as Node[]}
                      edges={activePipeDetail?.edges as Edge[]}
                    />
                  )}
                </div>

                <div className="absolute inset-0 pointer-events-none p-4 flex flex-col justify-between bg-gradient-to-b from-background/80 via-transparent to-background/80">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <div className="text-[10px] text-primary uppercase tracking-widest font-bold">
                        {getPipeDisplayName(activeMeta)}
                      </div>
                      <div className="text-[9px] text-dim">
                        {getPipeStatusLabel(activeMeta)} • v{Number.isFinite(activeMeta.version) ? Number(activeMeta.version) : 0}
                        {activeMeta.updated_at ? ` • ${activeMeta.updated_at}` : ''}
                      </div>
                      {activeMeta.description ? (
                        <div className="text-[9px] text-textMain/60 max-w-[520px] truncate">
                          {activeMeta.description}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex items-center space-x-2 pointer-events-auto">
                      <button
                        onClick={openActivePipeInDesigner}
                        className="h-8 px-3 bg-panel border border-primary/40 text-primary hover:bg-primary/10 active:bg-primary/10 transition flex items-center space-x-2 backdrop-blur-sm"
                      >
                        <Play className="w-3 h-3" />
                        <span className="text-[10px] uppercase tracking-widest font-bold">Open</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    </div>
                    <div className="text-[9px] text-textMain/40 uppercase tracking-widest">
                      {activePipeDetail?.nodes?.length ?? 0} NODES • {Array.isArray(activePipeDetail?.edges) ? activePipeDetail!.edges!.length : 0} EDGES
                    </div>
                  </div>
                </div>
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}
