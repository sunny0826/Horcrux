import { Loader2 } from 'lucide-react';
import type { PipeMeta } from '../types';
import { getPipeDisplayName, getPipeStatusLabel } from '../utils/pipeUtils';

interface PipeThumbnailsProps {
  pipes: PipeMeta[];
  pipesTotal: number;
  isPipesLoading: boolean;
  isPipesLoadingMore: boolean;
  activePipeIndex: number;
  setActivePipeIndex: (index: number) => void;
  pipeListScrollRef: React.Ref<HTMLDivElement>;
  onPipeListScroll: () => void;
}

export function PipeThumbnails({
  pipes,
  pipesTotal,
  isPipesLoading,
  isPipesLoadingMore,
  activePipeIndex,
  setActivePipeIndex,
  pipeListScrollRef,
  onPipeListScroll,
}: PipeThumbnailsProps) {
  return (
    <div className="bg-background border border-border overflow-hidden flex flex-col h-full shadow-lg rounded-sm">
      <div className="p-3 border-b border-border flex items-center justify-between shrink-0">
        <div className="text-[10px] text-primary uppercase tracking-widest font-bold">Pipe_Thumbnails</div>
        <div className="text-[9px] text-textMain/40">
          {pipesTotal > 0 ? `${pipes.length} / ${pipesTotal}` : `${pipes.length}`} LOADED
        </div>
      </div>
      <div
        ref={pipeListScrollRef}
        onScroll={onPipeListScroll}
        className="flex-1 overflow-y-auto scrollbar-custom"
      >
        {pipes.length === 0 ? (
          <div className="p-3 text-[10px] text-textMain/60 uppercase tracking-widest">
            {isPipesLoading ? 'LOADING...' : 'EMPTY'}
          </div>
        ) : (
          <table className="w-full text-left font-mono text-[10px]">
            <thead className="bg-panel border-b border-border text-textMain/40 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3">PIPE_NAME</th>
                <th className="px-4 py-3 hidden sm:table-cell">PIPE_ID</th>
                <th className="px-4 py-3">VERSION</th>
                <th className="px-4 py-3 hidden md:table-cell">UPDATED_AT</th>
                <th className="px-4 py-3">STATE</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-textMain/60">
              {pipes.map((p, idx) => {
                const isActive = idx === activePipeIndex;
                const version = Number.isFinite(p.version) ? Number(p.version) : 0;
                const status = getPipeStatusLabel(p);

                return (
                  <tr
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    aria-selected={isActive}
                    onClick={() => setActivePipeIndex(idx)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActivePipeIndex(idx);
                      }
                    }}
                    className={[
                      'hx-pipe-list-item',
                      'cursor-pointer select-none outline-none',
                      'hover:bg-panel/80',
                      isActive ? 'bg-panel' : '',
                    ].join(' ')}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={isActive ? 'text-primary' : 'text-textMain'}>
                          {getPipeDisplayName(p)}
                        </span>
                        <span className="hidden lg:inline-block text-[9px] px-2 py-0.5 border border-primary/40 bg-background/40 text-primary uppercase tracking-widest">
                          {status}
                        </span>
                      </div>
                      <div className="text-[9px] text-textMain/60 truncate max-w-[420px]">
                        {p.description || `ID: ${p.id}`}
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-textMain/60">
                      <span className="truncate block max-w-[240px]">{p.id}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={version > 0 ? 'text-primary' : 'text-textMain/40'}>
                        v{version}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-textMain/60">
                      {p.updated_at || '-'}
                    </td>
                    <td className="px-4 py-3">
                      {isActive ? (
                        <span className="text-primary animate-pulse">ACTIVE</span>
                      ) : (
                        <span className="text-textMain/40">IDLE</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {(pipesTotal === 0 || pipes.length < pipesTotal) && (
          <div className="p-3 border-t border-border flex items-center justify-between">
            <div className="text-[9px] text-textMain/40 uppercase tracking-widest">
              SCROLL_TO_LOAD_MORE
            </div>
            {isPipesLoadingMore && (
              <div className="flex items-center gap-2 text-[9px] text-textMain/60 uppercase tracking-widest">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>LOADING_MORE</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
