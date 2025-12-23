import { useState } from 'react';
import { Workflow, ChevronLeft, ChevronRight, Play } from 'lucide-react';
import { PipeThumbnails } from './PipeThumbnails';
import { PipelinePreview } from './PipelinePreview';
import { LogPanel } from './LogPanel';
import { useTaskWebSocket } from '../hooks/useTaskWebSocket';
import { useDashboardStats } from '../hooks/useDashboardStats';
import { usePipes } from '../hooks/usePipes';
import { getPipeDisplayName } from '../utils/pipeUtils';
import api from '../api';
import type { LatestTask } from '../types';

// Icon mapping
const ProjectDiagramIcon = Workflow;

interface DashboardProps {
  setActiveTab: (tab: string) => void;
}

export function Dashboard({ setActiveTab }: DashboardProps) {
  const {
    activeTaskId, setActiveTaskId,
    taskStatus, setTaskStatus,
    taskLogs, setTaskLogs,
    targetStates, setTargetStates,
    taskCancelRequested, setTaskCancelRequested,
  } = useTaskWebSocket();

  const { stats, latestTask, setLatestTask } = useDashboardStats();
  
  const {
    pipes,
    isPipesLoading,
    isPipesLoadingMore,
    pipesError,
    pipesTotal,
    activePipeIndex,
    setActivePipeIndex,
    activePipeDetail,
    isPipeDetailLoading,
    isPipePreviewVisible,
    onPipeListScroll,
    pipeListScrollRef
  } = usePipes('dashboard');

  const [didClearLogs, setDidClearLogs] = useState(false);

  const executeSync = async () => {
    if (!activePipeDetail || !activePipeDetail.nodes) {
      alert('Please wait for pipeline details to load');
      return;
    }

    const nodes = activePipeDetail.nodes;
    const sourceNode = nodes.find(n => n.type === 'sourceNode');
    const targetNodes = nodes.filter(n => n.type === 'targetNode');

    if (!sourceNode || targetNodes.length === 0) {
      alert('Invalid pipeline: missing source or target nodes');
      return;
    }

    const missingTarget = targetNodes.find((n) => !n.data?.image);
    if (!sourceNode.data?.image || missingTarget) {
      alert('Please configure source image and target image first in Designer');
      return;
    }

    setTaskLogs([]);
    setTaskStatus('running');
    setTargetStates({});
    setTaskCancelRequested(false);
    setDidClearLogs(false);
    
    try {
      const sourceData = sourceNode.data || {};
      const targets = targetNodes.map(t => {
        const d = t.data || {};
        return {
          target_ref: String(d.image || ''),
          target_id: String(d.credId || ''),
        };
      });

      const res = await api.post('/tasks/sync', {
        source_ref: String(sourceData.image || ''),
        source_id: String(sourceData.credId || ''),
        targets: targets,
      });
      const task = res.data as unknown as LatestTask;
      setActiveTaskId(task.id);
      setLatestTask(task);
      setTaskLogs(['Task created, waiting for updates...']);
    } catch (e) {
      console.error('Failed to create task:', e);
      setTaskStatus('failed');
      setTaskLogs(['ERROR: Failed to create task']);
      alert('Failed to start sync task');
    }
  };

  const cancelTask = async () => {
    if (!activeTaskId) return;
    setTaskCancelRequested(true);
    try {
      await api.post(`/tasks/${encodeURIComponent(activeTaskId)}/cancel`);
      setTaskLogs((prev) => [...prev, 'USER: Cancel requested...']);
    } catch (e) {
      console.error('Failed to cancel task:', e);
      setTaskLogs((prev) => [...prev, 'ERROR: Failed to request cancel']);
      setTaskCancelRequested(false);
    }
  };

  const retryFailedTargets = async () => {
    if (!activeTaskId) return;
    const failedRefs = Object.values(targetStates)
      .filter((t) => t.status === 'failed')
      .map((t) => t.targetRef);
    
    if (failedRefs.length === 0) return;

    setTaskLogs((prev) => [...prev, `USER: Retrying ${failedRefs.length} failed targets...`]);
    setTaskStatus('running');
    
    setTargetStates((prev) => {
      const next = { ...prev };
      for (const ref of failedRefs) {
        if (next[ref]) {
          next[ref] = { ...next[ref], status: 'pending', error: undefined };
        }
      }
      return next;
    });

    try {
      await api.post(`/tasks/${encodeURIComponent(activeTaskId)}/retry`, { target_refs: failedRefs });
    } catch (e) {
      console.error('Failed to retry:', e);
      setTaskStatus('failed');
      setTaskLogs((prev) => [...prev, 'ERROR: Retry failed, please check network or backend status']);
    }
  };

  const clearLogs = () => {
    setTaskLogs([]);
    setDidClearLogs(true);
    window.setTimeout(() => setDidClearLogs(false), 900);
  };

  const locateNodeFromLog = (log: string) => {
    console.log('Locate node from log:', log);
  };

  const openActivePipeInDesigner = () => {
    const id = pipes[activePipeIndex]?.id;
    if (!id) return;
    localStorage.setItem('horcrux_active_pipe_id', id);
    setActiveTab('designer');
  };

  return (
    <div className="absolute inset-0 overflow-y-auto p-8 space-y-8">
      {/* 统计概览 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Active_Threads', value: stats.active_threads.toString(), color: 'text-primary' },
          { label: 'Total_Data_Size', value: stats.total_data_size, color: 'text-textMain' },
          { label: 'Total_Tasks', value: stats.total_tasks.toString(), color: 'text-textMain' },
          { label: 'Auth_Keys', value: stats.auth_keys.toString().padStart(2, '0'), color: 'text-textMain' },
        ].map((stat, i) => (
          <div key={i} className="bg-panel p-4 border border-border relative group">
            <div className="text-textMain/40 text-[10px] uppercase mb-1">{stat.label}</div>
            <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* 可视化流程预览 */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-textMain/60 uppercase tracking-widest flex items-center">
            <ProjectDiagramIcon />
            <span className="ml-2">
              Pipelines: {pipes.length > 0 ? `${getPipeDisplayName(pipes[activePipeIndex])}` : (latestTask ? (latestTask.name || latestTask.id) : 'Production-Sync-Task')}
            </span>
          </h3>
          <div className="flex space-x-1">
            <button
              onClick={() => setActivePipeIndex((pipes.length ? (activePipeIndex - 1 + pipes.length) % pipes.length : activePipeIndex))}
              disabled={pipes.length <= 1}
              className={`w-8 h-8 bg-panel border border-border transition flex items-center justify-center ${
                pipes.length <= 1 ? 'opacity-40 cursor-not-allowed text-textMain/40' : 'text-textMain/60 hover:text-primary'
              }`}
              aria-label="Previous pipeline"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={executeSync}
              disabled={pipes.length === 0}
              className={`h-8 px-3 bg-panel border border-border transition flex items-center justify-center space-x-2 ${
                pipes.length === 0 ? 'opacity-40 cursor-not-allowed text-textMain/40' : 'text-dim hover:text-primary'
              }`}
              aria-label="Start sync task"
            >
              <Play className="w-3 h-3" />
              <span className="text-[10px] uppercase tracking-widest font-bold">Start</span>
            </button>
            <button
              onClick={() => setActivePipeIndex((pipes.length ? (activePipeIndex + 1) % pipes.length : activePipeIndex))}
              disabled={pipes.length <= 1}
              className={`w-8 h-8 bg-panel border border-border transition flex items-center justify-center ${
                pipes.length <= 1 ? 'opacity-40 cursor-not-allowed text-textMain/40' : 'text-textMain/60 hover:text-primary'
              }`}
              aria-label="Next pipeline"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
        
        {/* 2025-12-22：按原型布局将 Pipe_Thumbnails 独立成新行，避免与预览区域同一水平线 */}
        <div className="flex flex-col gap-4">
          <PipelinePreview
            pipes={pipes}
            activePipeIndex={activePipeIndex}
            pipesError={pipesError}
            isPipesLoading={isPipesLoading}
            isPipeDetailLoading={isPipeDetailLoading}
            activePipeDetail={activePipeDetail}
            isPipePreviewVisible={isPipePreviewVisible}
            openActivePipeInDesigner={openActivePipeInDesigner}
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-[320px]">
            <PipeThumbnails
              pipes={pipes}
              pipesTotal={pipesTotal}
              isPipesLoading={isPipesLoading}
              isPipesLoadingMore={isPipesLoadingMore}
              activePipeIndex={activePipeIndex}
              setActivePipeIndex={setActivePipeIndex}
              pipeListScrollRef={pipeListScrollRef}
              onPipeListScroll={onPipeListScroll}
            />

            <div className="bg-background border border-border overflow-hidden flex flex-col h-full shadow-lg rounded-sm">
              <LogPanel
                taskLogs={taskLogs}
                taskStatus={taskStatus}
                activeTaskId={activeTaskId}
                taskCancelRequested={taskCancelRequested}
                targetStates={targetStates}
                showLogs={true}
                setShowLogs={() => {}}
                onClearLogs={clearLogs}
                didClearLogs={didClearLogs}
                onCancelTask={cancelTask}
                onRetryFailedTargets={retryFailedTargets}
                onLocateNode={locateNodeFromLog}
                isMdUp={true}
                variant="card"
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
