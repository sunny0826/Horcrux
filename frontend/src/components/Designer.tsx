import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import ReactFlow, { 
  addEdge, 
  Background, 
  Controls, 
  type Connection, 
  type Node,
  type NodeChange,
  type EdgeChange,
  MarkerType,
  type ReactFlowInstance,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  Panel
} from 'reactflow';
import 'reactflow/dist/style.css';
import { SourceNode, TargetNode, ProcessorNode } from './CustomNodes';
import { Play, Save, Database, ArrowRight, Terminal, X, Loader2, Settings2, Key, Plus, History, ScrollText, Copy, Archive, Globe, Layers, ChevronLeft, ChevronRight } from 'lucide-react';
import api from '../api';
import { classifyEdgeChanges, classifyNodeChanges } from './pipelineChangeClassifier';
import { RegistrySourceConfig } from './RegistrySourceConfig';
import { LogPanel } from './LogPanel';
import { usePipeline } from '../hooks/usePipeline';
import type { Credential, NodeDraft, TargetRuntimeState, TaskEvent, SyncIndicatorState, LoadedArchive } from '../types';

const nodeTypes = {
  sourceNode: SourceNode,
  targetNode: TargetNode,
  processorNode: ProcessorNode,
};

const modalOverlayClassName = [
  'fixed inset-0 bg-black/70 backdrop-blur-[1px]',
  'opacity-0 transition-opacity duration-200',
  'data-[state=open]:opacity-100 data-[state=closed]:opacity-0',
].join(' ');
const modalShellClassName = [
  'fixed left-1/2 top-1/2 w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2',
  'bg-panel border border-border shadow-2xl',
  'opacity-0 scale-95 transition-[opacity,transform] duration-200',
  'data-[state=open]:opacity-100 data-[state=open]:scale-100',
  'data-[state=closed]:opacity-0 data-[state=closed]:scale-95',
  'focus:outline-none',
].join(' ');
const modalHeaderClassName = 'p-4 border-b border-border bg-panel flex items-center justify-between';
const modalIconTitleClassName = 'text-[11px] font-bold text-primary uppercase tracking-[0.2em]';
const modalCloseBtnClassName =
  'p-1.5 border border-border text-textMain/40 hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation';

const Designer: React.FC = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  
  // 使用自定义 Hook 管理 Pipeline 状态
  // Use custom hook to manage Pipeline state
  const {
    pipes,
    pipeId,
    pipeName,
    setPipeName,
    pipeDescription,
    setPipeDescription,
    pipeVersion,
    isDirty,
    markDirty,
    isPipeLoading,
    isSaving,
    savePipe,
    isAutoSaving,
    lastAutoSavedAt,
    autoSaveError,
    autoSaveLogs,
    clearAutoSaveLogs,
    conflictServerMeta,
    pipeVersions,
    loadVersions,
    loadVersion,
    pipeOps,
    loadOps,
    refreshPipes,
    loadPipeById,
    resetToNewPipe,
    createPipe,
    deletePipeById,
    forceOverwritePipe,
    reloadPipeFromServer,
    recordPipeOp,
  } = usePipeline(nodes, edges, setNodes, setEdges);

  const [isSyncing, setIsSyncing] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(localStorage.getItem('horcrux_active_task_id'));
  const [showLogs, setShowLogs] = useState(localStorage.getItem('horcrux_show_logs') === 'true');
  const [taskLogs, setTaskLogs] = useState<string[]>([]);
  const [taskStatus, setTaskStatus] = useState<string>('idle'); // idle, running, success, failed
  const [targetStates, setTargetStates] = useState<Record<string, TargetRuntimeState>>({});
  const [taskCancelRequested, setTaskCancelRequested] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [isNodeDialogOpen, setIsNodeDialogOpen] = useState(false);
  const [nodeDraft, setNodeDraft] = useState<NodeDraft>({
    label: '',
    image: '',
    credId: '',
    params: '',
  });
  const [loadedArchives, setLoadedArchives] = useState<LoadedArchive[]>([]);
  const [sourceType, setSourceType] = useState<'registry' | 'archive'>('registry');
  const [didClearLogs, setDidClearLogs] = useState(false);
  const restoredTaskIdRef = useRef<string | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [pipeSearch, setPipeSearch] = useState('');
  const [activeSidebarTab, setActiveSidebarTab] = useState<'pipes' | 'metadata' | null>(() => {
    if (typeof window === 'undefined') return null;
    return (localStorage.getItem('horcrux_active_sidebar_tab') as 'pipes' | 'metadata' | null) || null;
  });
  const [isPipeDialogOpen, setIsPipeDialogOpen] = useState(false);
  const [pipeDraftName, setPipeDraftName] = useState('');
  const [pipeDraftDescription, setPipeDraftDescription] = useState('');
  const [isCreatePipeDialogOpen, setIsCreatePipeDialogOpen] = useState(false);
  const [createPipeError, setCreatePipeError] = useState<string | null>(null);
  const [isCreatingPipe, setIsCreatingPipe] = useState(false);
  const [isVersionsDialogOpen, setIsVersionsDialogOpen] = useState(false);
  const [isAutoSaveLogDialogOpen, setIsAutoSaveLogDialogOpen] = useState(false);
  const [isConflictDialogOpen, setIsConflictDialogOpen] = useState(false);
  const [isOpsDialogOpen, setIsOpsDialogOpen] = useState(false);
  const [isPipeMetaEditing, setIsPipeMetaEditing] = useState(false);
  const [metaTab, setMetaTab] = useState<'meta' | 'nodes' | 'edges'>('meta');
  const [metaSearch, setMetaSearch] = useState('');
  const [metaSort, setMetaSort] = useState<'key_asc' | 'key_desc'>('key_asc');
  const [metaListVisibleCount, setMetaListVisibleCount] = useState(60);
  const [isMetaDetailOpen, setIsMetaDetailOpen] = useState(false);
  const [metaDetailItem, setMetaDetailItem] = useState<{ key: string; value: string } | null>(null);
  const createPipeNameInputRef = useRef<HTMLInputElement | null>(null);
  const reactFlowApiRef = useRef<ReactFlowInstance | null>(null);
  const metaScrollRef = useRef<HTMLDivElement | null>(null);
  const [isMdUp, setIsMdUp] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.matchMedia?.('(min-width: 768px)')?.matches ?? true;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia?.('(min-width: 768px)');
    if (!mq) return;
    const onChange = () => setIsMdUp(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activeSidebarTab) {
      localStorage.setItem('horcrux_active_sidebar_tab', activeSidebarTab);
    } else {
      localStorage.removeItem('horcrux_active_sidebar_tab');
    }
  }, [activeSidebarTab]);

  const locateNodeFromLog = useCallback((line: string) => {
    const patterns = [
      /\bnode_id[:=]\s*([^\s,]+)/i,
      /\bnode[:=]\s*([^\s,]+)/i,
      /\bnodeId[:=]\s*([^\s,]+)/i,
    ];
    let nodeId: string | null = null;
    for (const re of patterns) {
      const m = line.match(re);
      if (m?.[1]) {
        nodeId = String(m[1]);
        break;
      }
    }
    if (!nodeId) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setNodes((prev) =>
      prev.map((n) => ({
        ...n,
        selected: n.id === nodeId,
      })),
    );
    const abs = (node as Node & { positionAbsolute?: { x: number; y: number } }).positionAbsolute;
    const x = (abs?.x ?? node.position.x) + (node.width ? node.width / 2 : 0);
    const y = (abs?.y ?? node.position.y) + (node.height ? node.height / 2 : 0);
    reactFlowApiRef.current?.setCenter?.(x, y, { zoom: 1.2, duration: 350 });
  }, [nodes, setNodes]);

  useEffect(() => {
    setMetaListVisibleCount(60);
  }, [metaSearch, metaSort, metaTab]);

  const metaItems = useMemo(() => {
    if (metaTab === 'meta') {
      return [
        { key: 'id', value: pipeId || '-' },
        { key: 'name', value: pipeName || 'NEW_PIPE_DESIGN' },
        { key: 'description', value: pipeDescription || '-' },
        { key: 'version', value: pipeVersion > 0 ? String(pipeVersion) : '-' },
        { key: 'dirty', value: isDirty ? 'true' : 'false' },
        { key: 'autosave', value: isAutoSaving ? 'saving' : (lastAutoSavedAt || '-') },
        { key: 'nodes', value: String(nodes.length) },
        { key: 'edges', value: String(edges.length) },
      ];
    }
    if (metaTab === 'nodes') {
      return nodes.map((n) => ({
        key: n.id,
        value: `${String(n.data?.label ?? '-')}${n.data?.image ? ` · ${String(n.data?.image)}` : ''}`,
      }));
    }
    return edges.map((e) => ({
      key: e.id,
      value: `${e.source} -> ${e.target}${e.label ? ` · ${String(e.label)}` : ''}`,
    }));
  }, [edges, isAutoSaving, isDirty, lastAutoSavedAt, metaTab, nodes, pipeDescription, pipeId, pipeName, pipeVersion]);

  const filteredMetaItems = useMemo(() => {
    const q = metaSearch.trim().toLowerCase();
    const list = q
      ? metaItems.filter((it) => `${it.key} ${it.value}`.toLowerCase().includes(q))
      : metaItems;
    const sorted = list.slice().sort((a, b) => a.key.localeCompare(b.key));
    return metaSort === 'key_desc' ? sorted.reverse() : sorted;
  }, [metaItems, metaSearch, metaSort]);

  const visibleMetaItems = useMemo(() => {
    const total = filteredMetaItems.length;
    const n = Math.max(0, Math.min(total, metaListVisibleCount));
    return filteredMetaItems.slice(0, n);
  }, [filteredMetaItems, metaListVisibleCount]);

  const onMetaScroll = useCallback(() => {
    const el = metaScrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      const total = filteredMetaItems.length;
      if (metaListVisibleCount < total) {
        setTimeout(() => setMetaListVisibleCount((v) => Math.min(total, v + 60)), 0);
      }
    }
  }, [filteredMetaItems.length, metaListVisibleCount]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);



  const selectPipe = useCallback(async (id: string) => {
    if (!id || id === pipeId) return;
    if (isDirty && !window.confirm('Current pipeline has unsaved changes. Switching will lose changes. Continue?')) {
      return;
    }
    await loadPipeById(id);
    setIsPipeDialogOpen(false);
  }, [isDirty, loadPipeById, pipeId]);

  // Fetch credentials and try to load the latest Pipe
  useEffect(() => {
    const init = async () => {
      try {
        const credsRes = await api.get('/vault/credentials');
        setCredentials(credsRes.data);

        const list = await refreshPipes();
        const storedPipeId = localStorage.getItem('horcrux_active_pipe_id');
        const preferredId =
          storedPipeId && list.some((p) => p.id === storedPipeId)
            ? storedPipeId
            : (list[0]?.id ?? null);

        if (preferredId) {
          const ok = await loadPipeById(preferredId);
          if (!ok) {
            resetToNewPipe();
          }
        } else {
          resetToNewPipe();
        }

        if (activeTaskId && restoredTaskIdRef.current !== activeTaskId) {
          try {
            const taskRes = await api.get(`/tasks/${activeTaskId}`);
            const task = taskRes.data;
            setTaskStatus(task.status);
            setTaskLogs(task.logs || []);
            setTaskCancelRequested(Boolean(task.cancel_requested || task.cancelRequested));
            if (Array.isArray(task.targets)) {
              setTargetStates(() => {
                const next: Record<string, TargetRuntimeState> = {};
                for (const t of task.targets) {
                  if (!t || !t.target_ref) continue;
                  next[String(t.target_ref)] = {
                    targetRef: String(t.target_ref),
                    targetId: String(t.target_id || ''),
                    status: String(t.status || 'pending'),
                    progress: Number(t.progress || 0),
                    attempts: Number(t.attempts || 0),
                    error: t.error ? String(t.error) : undefined,
                  };
                }
                return next;
              });
            }
            if (task.status === 'running') {
              setIsSyncing(true);
            }
          } catch (e) {
            console.error('Failed to fetch active task details:', e);
          } finally {
            restoredTaskIdRef.current = activeTaskId;
          }
        }
      } catch (error) {
        console.error('Initialization failed:', error);
      }
    };
    init();
  }, [activeTaskId, loadPipeById, refreshPipes, resetToNewPipe]);

  useEffect(() => {
    if (activeTaskId) {
      localStorage.setItem('horcrux_active_task_id', activeTaskId);
    } else {
      localStorage.removeItem('horcrux_active_task_id');
    }
  }, [activeTaskId]);

  useEffect(() => {
    localStorage.setItem('horcrux_show_logs', String(showLogs));
  }, [showLogs]);

  const onConnect = useCallback(
    (params: Connection) => {
      markDirty();
      recordPipeOp('edge:add', params);
      setEdges((eds) => addEdge({ ...params, animated: true, style: { stroke: 'var(--primary-green)' } }, eds));
    },
    [markDirty, recordPipeOp, setEdges]
  );

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const { touched, ops } = classifyNodeChanges(changes);
    if (touched) {
      markDirty();
      for (const op of ops) {
        recordPipeOp(op.kind, op.data);
      }
    }
    onNodesChange(changes);
  }, [markDirty, onNodesChange, recordPipeOp]);

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    const { touched, ops } = classifyEdgeChanges(changes);
    if (touched) {
      markDirty();
      for (const op of ops) {
        recordPipeOp(op.kind, op.data);
      }
    }
    onEdgesChange(changes);
  }, [markDirty, onEdgesChange, recordPipeOp]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
    setNodeDraft({
      label: String(node.data?.label ?? ''),
      image: String(node.data?.image ?? ''),
      credId: String(node.data?.credId ?? ''),
      params: String(node.data?.params ?? ''),
    });
    setIsNodeDialogOpen(true);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setIsNodeDialogOpen(false);
  }, []);

  const updateNodeData = useCallback((id: string, newData: Record<string, string | undefined>) => {
    markDirty();
    recordPipeOp('node:update', { id, patch: newData });
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, ...newData } };
        }
        return node;
      }),
    );
  }, [markDirty, recordPipeOp, setNodes]);

  const closeNodeDialog = useCallback(() => {
    setIsNodeDialogOpen(false);
    setSelectedNode(null);
  }, []);

  const handleUpdateDraft = useCallback((updates: Partial<NodeDraft>) => {
    setNodeDraft((prev) => ({ ...prev, ...updates }));
  }, []);

    const saveNodeDraft = useCallback(() => {
    if (!selectedNode) return;
    
    // Check if we have an archiveRef stash in nodeDraft (from archive selection)
    const extraData: Record<string, string | undefined> = {};
    const draft = nodeDraft as unknown as Record<string, string | undefined>;
    if (draft.archiveRef) {
      extraData.archiveRef = draft.archiveRef;
      if (draft.displayImage) {
        extraData.displayImage = draft.displayImage;
      }
    } else {
      // If manually changed image or switched to registry, clear archiveRef and displayImage
      if (sourceType === 'registry') {
        extraData.archiveRef = undefined;
        extraData.displayImage = undefined;
      }
    }

    updateNodeData(selectedNode.id, {
      label: nodeDraft.label,
      image: nodeDraft.image,
      credId: nodeDraft.credId,
      params: nodeDraft.params,
      ...extraData,
    });
    closeNodeDialog();
  }, [closeNodeDialog, nodeDraft, selectedNode, updateNodeData, sourceType]);

  const fetchArchives = useCallback(async () => {
    try {
      const res = await api.get('/archives');
      setLoadedArchives(res.data || []);
    } catch (e) {
      console.error('Failed to fetch archives:', e);
    }
  }, []);

  const removeSelectedNode = useCallback(() => {
    if (!selectedNode) return;
    markDirty();
    recordPipeOp('node:remove', { id: selectedNode.id });
    setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id));
    closeNodeDialog();
  }, [closeNodeDialog, markDirty, recordPipeOp, selectedNode, setNodes]);

  const clearLogs = useCallback(() => {
    setTaskLogs([]);
    setDidClearLogs(true);
    window.setTimeout(() => setDidClearLogs(false), 900);
  }, []);

  const openPipeManager = useCallback(async () => {
    setIsPipeDialogOpen(true);
    try {
      await refreshPipes();
    } catch (e) {
      console.error('Failed to refresh pipes:', e);
    }
  }, [refreshPipes]);

  const openCreatePipeDialog = useCallback(() => {
    setCreatePipeError(null);
    setPipeDraftName('');
    setPipeDraftDescription('');
    setIsCreatePipeDialogOpen(true);
    window.setTimeout(() => createPipeNameInputRef.current?.focus(), 0);
  }, []);

  const handleCreatePipe = useCallback(async () => {
    const name = pipeDraftName.trim();
    const description = pipeDraftDescription.trim();
    if (!name) {
      setCreatePipeError('Pipeline name cannot be empty');
      window.setTimeout(() => createPipeNameInputRef.current?.focus(), 0);
      return;
    }
    setCreatePipeError(null);
    setIsCreatingPipe(true);
    try {
      const success = await createPipe(name, description);
      if (success) {
        setPipeDraftName('');
        setPipeDraftDescription('');
        setPipeSearch('');
        setIsCreatePipeDialogOpen(false);
      } else {
        setCreatePipeError('Failed to create pipeline');
      }
    } finally {
      setIsCreatingPipe(false);
    }
  }, [createPipe, pipeDraftDescription, pipeDraftName]);

  const openVersions = useCallback(async () => {
    await loadVersions();
    setIsVersionsDialogOpen(true);
  }, [loadVersions]);

  const openAutoSaveLogs = useCallback(() => {
    setIsAutoSaveLogDialogOpen(true);
  }, []);

  const openOps = useCallback(async () => {
    await loadOps();
    setIsOpsDialogOpen(true);
    setIsPipeDialogOpen(false);
  }, [loadOps]);

  // WebSocket real-time log handling
  useEffect(() => {
    if (!activeTaskId) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isTauri = typeof window !== 'undefined' && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = isTauri ? 'ws://127.0.0.1:7626/api/ws' : `${protocol}//${window.location.host}/api/ws`;
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('WS: Connected for task', activeTaskId);
    };

    ws.onmessage = (event) => {
      const data = event.data as string;
      if (data.startsWith(`TASK_LOG:${activeTaskId}:`)) {
        const log = data.replace(`TASK_LOG:${activeTaskId}:`, '');
        setTaskLogs(prev => {
          // Avoid duplicate logs (simple check)
          if (prev.includes(log)) return prev;
          return [...prev, log];
        });
      } else if (data.startsWith(`TASK_EVENT:${activeTaskId}:`)) {
        const raw = data.replace(`TASK_EVENT:${activeTaskId}:`, '');
        try {
          const e = JSON.parse(raw) as TaskEvent;
          if (e.type === 'task_update') {
            if (e.status) {
              setTaskStatus(String(e.status));
              setIsSyncing(String(e.status) === 'running');
            }
            if (typeof e.cancel_requested === 'boolean') {
              setTaskCancelRequested(e.cancel_requested);
            }
          } else if (e.type === 'target_update' && e.target_ref) {
            const targetRef = String(e.target_ref);
            setTargetStates((prev) => {
              const current = prev[targetRef];
              const next: TargetRuntimeState = {
                targetRef,
                targetId: current?.targetId,
                status: e.target_status ? String(e.target_status) : (current?.status || 'pending'),
                progress: typeof e.progress === 'number' ? e.progress : (current?.progress || 0),
                attempts: typeof e.attempts === 'number' ? e.attempts : (current?.attempts || 0),
                error: e.error ? String(e.error) : current?.error,
              };
              if (current && current.error && !e.error) {
                next.error = undefined;
              }
              return { ...prev, [targetRef]: next };
            });
          }
        } catch (err) {
          console.error('Failed to parse TASK_EVENT:', err);
        }
      } else if (data === `TASK_SUCCESS:${activeTaskId}`) {
        setTaskStatus('success');
        setIsSyncing(false);
      } else if (data.startsWith(`TASK_FAILED:${activeTaskId}:`)) {
        setTaskStatus('failed');
        setIsSyncing(false);
      }
    };

    ws.onerror = (e) => console.error('WS Error:', e);
    ws.onclose = () => console.log('WS: Disconnected');

    return () => ws.close();
  }, [activeTaskId]);

  const cancelTask = useCallback(async () => {
    if (!activeTaskId) return;
    try {
      setTaskCancelRequested(true);
      await api.post(`/tasks/${activeTaskId}/cancel`);
    } catch (e) {
      console.error('Cancel task failed:', e);
      setTaskLogs((prev) => [...prev, 'ERROR: Failed to cancel request, please check network or backend status']);
      setTaskCancelRequested(false);
    }
  }, [activeTaskId]);

  const retryFailedTargets = useCallback(async () => {
    if (!activeTaskId) return;
    try {
      setIsSyncing(true);
      setTaskLogs([]);
      setTaskStatus('running');
      setTaskCancelRequested(false);
      setShowLogs(true);
      const res = await api.post(`/tasks/${activeTaskId}/retry`, { failed_only: true });
      setTargetStates(() => {
        const next: Record<string, TargetRuntimeState> = {};
        const tgs = Array.isArray(res.data?.targets) ? res.data.targets : [];
        for (const t of tgs) {
          if (!t || !t.target_ref) continue;
          next[String(t.target_ref)] = {
            targetRef: String(t.target_ref),
            targetId: String(t.target_id || ''),
            status: String(t.status || 'pending'),
            progress: Number(t.progress || 0),
            attempts: Number(t.attempts || 0),
            error: t.error ? String(t.error) : undefined,
          };
        }
        return next;
      });
      setActiveTaskId(res.data.id);
    } catch (e) {
      console.error('Retry failed:', e);
      setTaskStatus('failed');
      setIsSyncing(false);
      setTaskLogs((prev) => [...prev, 'ERROR: Retry failed, please check network or backend status']);
    }
  }, [activeTaskId]);

  const addNode = (type: string) => {
    const id = `${Date.now()}`;
    setNodes((nds) => {
      let initialImage = 'new:latest';

      if (type === 'targetNode') {
        const sourceNode = nds.find((n) => n.type === 'sourceNode');
        if (sourceNode && sourceNode.data?.image) {
          initialImage = sourceNode.data.image;
        }
      }

      const newNode: Node = {
        id,
        type,
        data: { label: type.replace('Node', '').toUpperCase(), image: initialImage, credId: '' },
        position: { x: 100, y: 100 },
      };
      markDirty();
      recordPipeOp('node:add', { id, type });
      return nds.concat(newNode);
    });
  };

  const executeSync = async () => {
    // Simple logic: find path connecting source and target from edges
    // Currently simplified: directly find sourceNode and targetNode in the graph
    const sourceNode = nodes.find(n => n.type === 'sourceNode');
    const targetNodes = nodes.filter(n => n.type === 'targetNode');

    if (!sourceNode || targetNodes.length === 0) {
      alert('Please ensure there is at least one source node (Source) and one target node (Target) on the canvas');
      return;
    }

    const missingTarget = targetNodes.find((n) => !n.data?.image);
    if (!sourceNode.data.image || missingTarget) {
      alert('Please configure source image and target image first');
      setSelectedNode(sourceNode.data.image ? missingTarget || targetNodes[0] : sourceNode);
      return;
    }

    setIsSyncing(true);
    setTaskLogs([]);
    setTaskStatus('running');
    setShowLogs(true);
    setTaskCancelRequested(false);
    
    try {
      // Use archiveRef if available for source
      const sourceData = sourceNode.data as Record<string, string | undefined>;
      const sourceRef = sourceData.archiveRef || sourceNode.data.image;
      
      const response = await api.post('/tasks/sync', {
        source_ref: sourceRef,
        source_id: sourceNode.data.credId,
        targets: targetNodes
          .map((n) => ({
            target_ref: n.data.image,
            target_id: n.data.credId,
          }))
          .filter((t) => Boolean(t.target_ref)),
      });
      setTargetStates(() => {
        const next: Record<string, TargetRuntimeState> = {};
        const tgs = Array.isArray(response.data?.targets) ? response.data.targets : [];
        for (const t of tgs) {
          if (!t || !t.target_ref) continue;
          next[String(t.target_ref)] = {
            targetRef: String(t.target_ref),
            targetId: String(t.target_id || ''),
            status: String(t.status || 'pending'),
            progress: Number(t.progress || 0),
            attempts: Number(t.attempts || 0),
            error: t.error ? String(t.error) : undefined,
          };
        }
        return next;
      });
      setActiveTaskId(response.data.id);
    } catch (error) {
      console.error('Sync failed:', error);
      setTaskStatus('failed');
      setIsSyncing(false);
      setTaskLogs(prev => [...prev, 'ERROR: Task failed to start, please check network or backend status']);
    }
  };

  const renderedEdges = useMemo(() => {
    if (!isSyncing) return edges;
    const markerEnd = { type: MarkerType.ArrowClosed, color: 'var(--primary-green)' };
    return edges.map((e) => ({
      ...e,
      animated: true,
      markerEnd,
      className: ['hx-sync-edge', e.className].filter(Boolean).join(' '),
    }));
  }, [edges, isSyncing]);

  const renderedNodes = useMemo(() => {
    const global: SyncIndicatorState =
      taskStatus === 'running'
        ? 'syncing'
        : taskStatus === 'success'
          ? 'success'
          : taskStatus === 'failed'
            ? 'error'
            : 'idle';

    if (global === 'idle') return nodes;

    return nodes.map((n) => {
      let state: SyncIndicatorState = global;

      if (n.type === 'targetNode') {
        const ref = String((n.data as { image?: unknown } | undefined)?.image ?? '');
        const t = ref ? targetStates[ref] : undefined;
        const s = String(t?.status ?? '');
        if (taskStatus === 'running') {
          state = s === 'success' ? 'success' : s === 'failed' ? 'error' : 'syncing';
        } else if (taskStatus === 'failed') {
          state = s === 'success' ? 'success' : 'error';
        } else {
          state = 'success';
        }
      } else if (taskStatus === 'running') {
        state = 'syncing';
      }

      return {
        ...n,
        data: {
          ...(n.data as Record<string, unknown>),
          syncState: state,
        },
      };
    });
  }, [nodes, targetStates, taskStatus]);

  return (
    <div className="h-full w-full relative flex flex-col md:flex-row overflow-hidden">
      <div className="flex-1 relative min-w-0">
        <ReactFlow
          nodes={renderedNodes}
          edges={renderedEdges}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          onInit={(instance) => {
            reactFlowApiRef.current = instance;
          }}
          fitView
          className="bg-background"
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Lines}
            color="var(--border-color)"
            gap={30}
            size={1}
          />
          <Controls className="!bg-panel !border-border !fill-primary" />
          
          <Panel position="top-left" className="!h-screen !max-h-screen !top-0 !left-0 !m-0 flex pointer-events-none z-50">
            <aside 
              className={[
                'pointer-events-auto h-full flex shadow-[2px_0_5px_rgba(0,0,0,0.3)] border-r border-border bg-panel backdrop-blur-sm transition-[width] duration-300 ease-in-out overflow-hidden',
                activeSidebarTab ? 'w-[300px]' : 'w-12',
                'hidden md:flex'
              ].join(' ')}
            >
              {/* Left Panel Content (Collapsible) */}
              <div className={`flex-1 flex flex-col h-full bg-panel transition-opacity duration-300 min-w-0 ${activeSidebarTab ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                {activeSidebarTab === 'pipes' && (
                  <>
                    <div className="p-4 border-b border-border">
                      <div className="text-[9px] text-textMain/60 uppercase font-bold tracking-widest mb-2">Current Pipeline</div>
                      <button
                        onClick={openPipeManager}
                        className="w-full text-left text-xs font-bold text-primary hover:text-primary/80 transition-colors truncate font-mono flex items-center justify-between group"
                        title="Manage Pipelines"
                      >
                        <span className="truncate">
                          {pipeName || 'NEW_PIPE_DESIGN'}
                          {isDirty ? '*' : ''}
                          {pipeVersion > 0 ? ` v${pipeVersion}` : ''}
                        </span>
                        <Settings2 className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>
                      {isPipeLoading && <div className="h-0.5 w-full bg-border mt-2 overflow-hidden"><div className="h-full bg-primary animate-progress"></div></div>}
                    </div>
                    
                    <div className="flex flex-col p-2 space-y-1 overflow-y-auto flex-1">
                      <button
                        onClick={() => {
                          if (isDirty && !window.confirm('Current pipeline has unsaved changes. Creating a new pipeline will lose changes. Continue?')) return;
                          setPipeDraftName('');
                          setPipeDraftDescription('');
                          openPipeManager();
                        }}
                        className="flex items-center space-x-3 px-3 py-3 hover:bg-background rounded text-textMain/60 hover:text-primary transition-colors text-left group"
                      >
                        <Plus className="w-4 h-4 group-hover:scale-110 transition-transform" />
                        <span className="text-[10px] font-bold uppercase tracking-wider">New Pipeline</span>
                      </button>
                      
                      <button
                        onClick={openVersions}
                        disabled={!pipeId}
                        className={`flex items-center space-x-3 px-3 py-3 hover:bg-background rounded transition-colors text-left group ${pipeId ? 'text-textMain/60 hover:text-primary' : 'opacity-40 cursor-not-allowed text-textMain/40'}`}
                      >
                        <History className="w-4 h-4 group-hover:scale-110 transition-transform" />
                        <span className="text-[10px] font-bold uppercase tracking-wider">Versions</span>
                      </button>
                      
                      <button
                        onClick={openOps}
                        disabled={!pipeId}
                        className={`flex items-center space-x-3 px-3 py-3 hover:bg-background rounded transition-colors text-left group ${pipeId ? 'text-textMain/60 hover:text-primary' : 'opacity-40 cursor-not-allowed text-textMain/40'}`}
                      >
                        <ScrollText className="w-4 h-4 group-hover:scale-110 transition-transform" />
                        <span className="text-[10px] font-bold uppercase tracking-wider">Operations</span>
                      </button>
                      
                      <button
                        onClick={openAutoSaveLogs}
                        className={`flex items-center space-x-3 px-3 py-3 hover:bg-background rounded transition-colors text-left group ${autoSaveError ? 'text-red-500 hover:text-red-400' : 'text-textMain/60 hover:text-primary'}`}
                      >
                        <Terminal className="w-4 h-4 group-hover:scale-110 transition-transform" />
                        <span className="text-[10px] font-bold uppercase tracking-wider">Autosave Logs</span>
                      </button>
                    </div>
                  </>
                )}

                {activeSidebarTab === 'metadata' && (
                   <div className="flex flex-col h-full overflow-hidden">
                    <div className="p-4 border-b border-border bg-panel">
                       <div className="flex items-center gap-2 min-w-0">
                          <h4 className="text-[11px] font-bold text-primary uppercase tracking-widest truncate">Pipe_Metadata</h4>
                          {isDirty && <span className="text-[10px] text-yellow-400 font-bold">DIRTY</span>}
                       </div>
                    </div>
                    
                    <div className="p-3 space-y-2 flex-1 overflow-y-auto">
                        <div className="flex flex-col gap-2">
                            <div className="inline-flex border border-border bg-background/40 rounded overflow-hidden" role="tablist">
                                {(['meta', 'nodes', 'edges'] as const).map((t) => (
                                    <button
                                    key={t}
                                    onClick={() => {
                                        setMetaTab(t);
                                        setMetaListVisibleCount(60);
                                        metaScrollRef.current?.scrollTo({ top: 0 });
                                    }}
                                    className={[
                                        'flex-1 px-2 py-1.5 text-[9px] uppercase font-bold transition-colors touch-manipulation',
                                        metaTab === t ? 'text-primary bg-primary/10' : 'text-textMain/40 hover:text-primary hover:bg-primary/10',
                                    ].join(' ')}
                                    >
                                    {t}
                                    </button>
                                ))}
                            </div>
                            
                            <div className="flex gap-2">
                                <input
                                value={metaSearch}
                                onChange={(e) => {
                                    setMetaSearch(e.target.value);
                                    setMetaListVisibleCount(60);
                                    metaScrollRef.current?.scrollTo({ top: 0 });
                                }}
                                className="flex-1 min-w-0 bg-background border border-border px-2 py-1.5 text-[10px] text-textMain focus:border-primary outline-none transition-colors"
                                placeholder="Search..."
                                />
                                <button
                                onClick={() => setMetaSort((v) => (v === 'key_asc' ? 'key_desc' : 'key_asc'))}
                                className="px-2 py-1 border border-border text-[9px] uppercase font-bold transition-colors text-textMain/40 hover:text-primary hover:bg-primary/10"
                                title="Sort"
                                >
                                {metaSort === 'key_asc' ? 'A->Z' : 'Z->A'}
                                </button>
                            </div>
                        </div>

                        <div
                            ref={metaScrollRef}
                            onScroll={onMetaScroll}
                            className="flex-1 overflow-y-auto border border-border bg-background/20 min-h-0"
                        >
                            <div className="p-2 space-y-1">
                                {visibleMetaItems.length === 0 ? (
                                    <div className="text-[10px] text-textMain/40 p-2">No data</div>
                                ) : (
                                    visibleMetaItems.map((it) => (
                                        <div
                                            key={it.key}
                                            className="group flex flex-col gap-1 border border-border/50 bg-background/40 px-2 py-2 hover:border-primary/30 hover:bg-primary/5 transition-colors"
                                        >
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                                    it.key === 'name' ? 'bg-primary' :
                                                    it.key === 'id' ? 'bg-blue-400' :
                                                    it.key === 'version' ? 'bg-purple-400' :
                                                    it.key === 'dirty' ? 'bg-yellow-400' : 'bg-border'
                                                }`} />
                                                <div className="text-[10px] text-textMain/60 font-mono break-all uppercase">{it.key}</div>
                                            </div>
                                            <div className="pl-3.5 flex items-start justify-between gap-2">
                                                <div className="text-[10px] text-textMain font-mono break-all line-clamp-2" title={it.value}>
                                                    {it.value}
                                                </div>
                                                {(it.value.length > 50 || it.value.includes('\n')) && (
                                                    <button
                                                        onClick={() => {
                                                            setMetaDetailItem(it);
                                                            setIsMetaDetailOpen(true);
                                                        }}
                                                        className="shrink-0 text-[9px] text-primary opacity-0 group-hover:opacity-100 transition-opacity uppercase font-bold"
                                                    >
                                                        EXP
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ))
                                )}
                                {metaListVisibleCount < filteredMetaItems.length && (
                                    <button
                                        onClick={() => setMetaListVisibleCount((v) => Math.min(filteredMetaItems.length, v + 120))}
                                        className="w-full mt-2 px-2 py-2 border border-border text-[9px] uppercase font-bold text-textMain/40 hover:text-primary"
                                    >
                                        LOAD MORE
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                   </div>
                )}
              </div>

              {/* Right Strip: Node Tools & Tab Toggles */}
              <div className="w-12 min-w-[3rem] flex flex-col items-center py-4 space-y-4 bg-panel z-20 border-l border-border h-full">
                {/* Add Node Buttons */}
                <button 
                  onClick={() => addNode('sourceNode')}
                  className="w-8 h-8 flex items-center justify-center border border-border hover:border-primary text-textMain/40 hover:text-primary transition-all cursor-pointer active:scale-95 group relative"
                  title="Add Source"
                >
                  <Database className="w-4 h-4" />
                  <span className="absolute left-full ml-2 px-2 py-1 bg-panel border border-border text-[9px] text-primary opacity-0 group-hover:opacity-100 whitespace-nowrap z-50 font-mono tracking-wider pointer-events-none">REGISTRY_SOURCE</span>
                </button>
                
                <button 
                  onClick={() => addNode('targetNode')}
                  className="w-8 h-8 flex items-center justify-center border border-border hover:border-primary text-textMain/40 hover:text-primary transition-all cursor-pointer active:scale-95 group relative"
                  title="Add Target"
                >
                  <ArrowRight className="w-4 h-4" />
                  <span className="absolute left-full ml-2 px-2 py-1 bg-panel border border-border text-[9px] text-primary opacity-0 group-hover:opacity-100 whitespace-nowrap z-50 font-mono tracking-wider pointer-events-none">TARGET_REGISTRY</span>
                </button>
                
                <div className="w-6 h-[1px] bg-border my-2"></div>
                
                {/* Tabs */}
                <button
                  onClick={() => setActiveSidebarTab((prev) => prev === 'pipes' ? null : 'pipes')}
                  className={`w-8 h-8 flex items-center justify-center border border-border hover:border-primary transition-all cursor-pointer active:scale-95 group relative ${activeSidebarTab === 'pipes' ? 'border-primary text-primary' : 'text-textMain/40 hover:text-primary'}`}
                  title="Pipelines"
                >
                  <Settings2 className="w-4 h-4" />
                  <span className="absolute left-full ml-2 px-2 py-1 bg-panel border border-border text-[9px] text-primary opacity-0 group-hover:opacity-100 whitespace-nowrap z-50 font-mono tracking-wider pointer-events-none">PIPELINES</span>
                </button>

                <button
                  onClick={() => setActiveSidebarTab((prev) => prev === 'metadata' ? null : 'metadata')}
                  className={`w-8 h-8 flex items-center justify-center border border-border hover:border-primary transition-all cursor-pointer active:scale-95 group relative ${activeSidebarTab === 'metadata' ? 'border-primary text-primary' : 'text-textMain/40 hover:text-primary'}`}
                  title="Metadata"
                >
                  <Layers className="w-4 h-4" />
                  <span className="absolute left-full ml-2 px-2 py-1 bg-panel border border-border text-[9px] text-primary opacity-0 group-hover:opacity-100 whitespace-nowrap z-50 font-mono tracking-wider pointer-events-none">METADATA</span>
                </button>

                {/* Toggle Button */}
                <button
                  onClick={() => setActiveSidebarTab((prev) => prev ? null : 'pipes')}
                  className="mt-auto mb-2 w-8 h-8 flex items-center justify-center border border-border hover:border-primary text-textMain/40 hover:text-primary transition-all cursor-pointer active:scale-95 group relative"
                  title={activeSidebarTab ? 'Collapse Sidebar' : 'Expand Sidebar'}
                >
                  {activeSidebarTab ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  <span className="absolute left-full ml-2 px-2 py-1 bg-panel border border-border text-[9px] text-primary opacity-0 group-hover:opacity-100 whitespace-nowrap z-50 font-mono tracking-wider pointer-events-none">
                    {activeSidebarTab ? 'COLLAPSE' : 'EXPAND'}
                  </span>
                </button>
              </div>
            </aside>
          </Panel>

          <Panel position="top-right" className="flex items-center space-x-2">
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="btn-secondary !py-1.5 flex items-center space-x-2 touch-manipulation"
            >
              <Terminal className="w-3 h-3" />
              <span>{showLogs ? 'HIDE_LOGS' : 'SHOW_LOGS'}</span>
            </button>
          <button 
            onClick={savePipe}
            disabled={isSaving || (!isDirty && !isAutoSaving)}
            className={[
              'btn-secondary !py-1.5 flex items-center space-x-2 touch-manipulation',
              isSaving || (!isDirty && !isAutoSaving) ? 'opacity-50 cursor-not-allowed' : '',
            ].join(' ')}
            title={!isSaving && !isDirty && !isAutoSaving ? 'Auto-saved' : 'Save Pipeline'}
          >
            {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            <span>{isSaving ? 'SAVING...' : (!isDirty && !isAutoSaving ? 'SAVED' : 'SAVE_PIPE')}</span>
          </button>
          <button 
            onClick={executeSync}
              disabled={isSyncing}
              className={`btn-primary !py-1.5 flex items-center space-x-2 touch-manipulation ${isSyncing ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {isSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              <span>{isSyncing ? 'SYNCING...' : 'EXECUTE_SYNC'}</span>
            </button>
          </Panel>

            <Dialog.Root
              open={isMetaDetailOpen}
              onOpenChange={(open) => {
                setIsMetaDetailOpen(open);
                if (!open) setMetaDetailItem(null);
              }}
            >
              <Dialog.Portal>
                <Dialog.Overlay className={modalOverlayClassName} />
                <Dialog.Content
                  className={[
                    modalShellClassName,
                    'max-w-[680px]',
                  ].join(' ')}
                >
                  <div className={modalHeaderClassName}>
                    <div className="flex items-center space-x-2 min-w-0">
                      <Dialog.Title className={modalIconTitleClassName}>Metadata Detail</Dialog.Title>
                      <div className="text-[10px] text-textMain font-mono truncate">{metaDetailItem?.key || ''}</div>
                    </div>
                    <Dialog.Close asChild>
                      <button className={modalCloseBtnClassName} aria-label="Close">
                        <X className="w-4 h-4" />
                      </button>
                    </Dialog.Close>
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="border border-border bg-background/40 p-3">
                      <div className="text-[9px] text-textMain/40 uppercase font-bold tracking-wider">KEY</div>
                      <div className="mt-1 text-[11px] text-textMain font-mono break-all">{metaDetailItem?.key || '-'}</div>
                    </div>
                    <div className="border border-border bg-background/40 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[9px] text-textMain/40 uppercase font-bold tracking-wider">VALUE</div>
                        <button
                          onClick={async () => {
                            const v = metaDetailItem?.value || '';
                            if (!v) return;
                            try {
                              await navigator.clipboard.writeText(v);
                            } catch (e) {
                              console.error('Copy failed:', e);
                              alert('Copy failed: Browser not supported or permission denied');
                            }
                          }}
                          className="p-1.5 border border-border text-textMain/40 hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-primary/40"
                          title="Copy"
                          aria-label="Copy value"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] text-textMain font-mono">
                        {metaDetailItem?.value || '-'}
                      </pre>
                    </div>
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
        </ReactFlow>
      </div>

      <LogPanel
        taskLogs={taskLogs}
        taskStatus={taskStatus}
        activeTaskId={activeTaskId}
        taskCancelRequested={taskCancelRequested}
        targetStates={targetStates}
        showLogs={showLogs}
        setShowLogs={setShowLogs}
        onClearLogs={clearLogs}
        didClearLogs={didClearLogs}
        onCancelTask={cancelTask}
        onRetryFailedTargets={retryFailedTargets}
        onLocateNode={locateNodeFromLog}
        isMdUp={isMdUp}
      />

      {/* Pipeline Manager Dialog */}
      <Dialog.Root
        open={isPipeDialogOpen}
        onOpenChange={(open) => {
          setIsPipeDialogOpen(open);
          if (!open) {
            setIsPipeMetaEditing(false);
          }
          if (open) {
            refreshPipes().catch((e) => console.error('Failed to refresh pipes:', e));
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={modalOverlayClassName} />
          <Dialog.Content
            className={[
              modalShellClassName,
              'max-w-[820px]',
            ].join(' ')}
          >
            <div className={modalHeaderClassName}>
              <div className="flex items-center space-x-2">
                <Dialog.Title className={modalIconTitleClassName}>Pipelines</Dialog.Title>
              </div>
              <Dialog.Close asChild>
                <button
                  className={modalCloseBtnClassName}
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
              <div className="border border-border bg-background/40 p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[9px] uppercase font-bold text-textMain/60 tracking-wider">Current Pipeline</div>
                  <button
                    onClick={() => setIsPipeMetaEditing((v) => !v)}
                    className="px-2 py-1 border border-border text-[8px] uppercase font-bold transition-colors touch-manipulation text-textMain/40 hover:text-primary hover:bg-primary/10 active:bg-primary/10"
                  >
                    {isPipeMetaEditing ? 'LOCK' : 'EDIT'}
                  </button>
                </div>
                <div className="space-y-2">
                  <input
                    type="text"
                    value={pipeName}
                    disabled={!isPipeMetaEditing}
                    onChange={(e) => {
                      setPipeName(e.target.value);
                      markDirty();
                      recordPipeOp('pipe:meta', { field: 'name' });
                    }}
                    className="w-full bg-background border border-border p-2 text-[10px] text-textMain font-bold focus:border-primary outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed disabled:text-textMain/40"
                    placeholder="Pipeline name"
                  />
                  <textarea
                    value={pipeDescription}
                    disabled={!isPipeMetaEditing}
                    onChange={(e) => {
                      setPipeDescription(e.target.value);
                      markDirty();
                      recordPipeOp('pipe:meta', { field: 'description' });
                    }}
                    rows={3}
                    className="w-full bg-background border border-border p-2 text-[10px] text-textMain focus:border-primary outline-none transition-colors resize-y disabled:opacity-60 disabled:cursor-not-allowed disabled:text-textMain/40"
                    placeholder="Pipeline description"
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={savePipe}
                      disabled={isSaving || (!isDirty && !isAutoSaving)}
                      className={[
                        'btn-primary !py-2 !px-4 touch-manipulation',
                        isSaving || (!isDirty && !isAutoSaving) ? 'opacity-50 cursor-not-allowed' : '',
                      ].join(' ')}
                      title={!isSaving && !isDirty && !isAutoSaving ? 'Auto-saved' : 'Save'}
                    >
                      {isSaving ? 'SAVING...' : (!isDirty && !isAutoSaving ? 'SAVED' : 'SAVE')}
                    </button>
                    <button
                      onClick={openVersions}
                      disabled={!pipeId}
                      className="btn-secondary !py-2 !px-4 touch-manipulation"
                    >
                      VERSIONS
                    </button>
                    <button
                      onClick={openOps}
                      disabled={!pipeId}
                      className="btn-secondary !py-2 !px-4 touch-manipulation"
                    >
                      OPS
                    </button>
                    <button
                      onClick={() => (pipeId ? deletePipeById(pipeId) : resetToNewPipe())}
                      className="px-3 py-2 border border-red-900/50 text-red-500 text-[9px] uppercase font-bold hover:bg-red-500/10 active:bg-red-500/10 transition-colors touch-manipulation"
                    >
                      DELETE
                    </button>
                  </div>
                </div>
              </div>

              <div className="border border-border bg-background/40 p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[9px] uppercase font-bold text-textMain/60 tracking-wider">Pipeline List</div>
                  <input
                    type="text"
                    value={pipeSearch}
                    onChange={(e) => setPipeSearch(e.target.value)}
                    className="w-[220px] bg-background border border-border p-2 text-[10px] text-textMain focus:border-primary outline-none transition-colors"
                    placeholder="Search by name"
                  />
                </div>
                <div className="space-y-2">
                  {pipes
                    .filter((p) => {
                      const q = pipeSearch.trim().toLowerCase();
                      if (!q) return true;
                      return (p.name || '').toLowerCase().includes(q);
                    })
                    .map((p) => (
                      <div key={p.id} className="border border-border bg-background/40 p-2 flex items-center justify-between gap-2">
                        <button
                          onClick={() => selectPipe(p.id)}
                          className="flex-1 text-left"
                          title={p.id}
                        >
                          <div className="text-[10px] text-textMain font-bold truncate">
                            {p.name}{p.id === pipeId ? ' (active)' : ''}
                          </div>
                          <div className="text-[8px] text-textMain/40 font-mono truncate">
                            {p.id} · v{p.version} · {p.updated_at}
                          </div>
                        </button>
                        <button
                          onClick={() => deletePipeById(p.id)}
                          className="p-1.5 border border-red-900/50 text-red-500 hover:bg-red-500/10 active:bg-red-500/10 transition-colors touch-manipulation"
                          title="Delete"
                        >
                          <ScrollText className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-border bg-panel flex justify-end">
              <button
                onClick={openCreatePipeDialog}
                className="btn-secondary !py-2 !px-4 touch-manipulation flex items-center gap-2"
              >
                <Plus className="w-3.5 h-3.5" />
                CREATE NEW PIPELINE
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={isCreatePipeDialogOpen}
        onOpenChange={setIsCreatePipeDialogOpen}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={modalOverlayClassName} />
          <Dialog.Content
            className={[
              modalShellClassName,
              'max-w-[500px]',
            ].join(' ')}
          >
            <div className={modalHeaderClassName}>
              <div className="flex items-center space-x-2">
                <Dialog.Title className={modalIconTitleClassName}>Create New Pipeline</Dialog.Title>
              </div>
              <Dialog.Close asChild>
                <button
                  className={modalCloseBtnClassName}
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="p-4 space-y-5">
              <div className="space-y-2">
                <label className="text-[9px] uppercase font-bold text-textMain/60 tracking-wider">Pipeline Name</label>
                <input
                  ref={createPipeNameInputRef}
                  type="text"
                  value={pipeDraftName}
                  onChange={(e) => setPipeDraftName(e.target.value)}
                  className="w-full bg-background border border-border p-2 text-[10px] text-textMain font-bold focus:border-primary outline-none transition-colors"
                  placeholder="Enter pipeline name"
                />
                {createPipeError && (
                  <div className="text-[9px] text-red-500">{createPipeError}</div>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-[9px] uppercase font-bold text-textMain/60 tracking-wider">Pipeline Description</label>
                <textarea
                  value={pipeDraftDescription}
                  onChange={(e) => setPipeDraftDescription(e.target.value)}
                  rows={3}
                  className="w-full bg-background border border-border p-2 text-[10px] text-textMain focus:border-primary outline-none transition-colors resize-y"
                  placeholder="Enter pipeline description (optional)"
                />
              </div>
            </div>

            <div className="p-4 border-t border-border bg-panel flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  className="btn-secondary !py-2 !px-4 touch-manipulation"
                >
                  CANCEL
                </button>
              </Dialog.Close>
              <button
                onClick={handleCreatePipe}
                disabled={isCreatingPipe}
                className="btn-primary !py-2 !px-4 touch-manipulation"
              >
                {isCreatingPipe ? 'CREATING...' : 'CREATE'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={isVersionsDialogOpen}
        onOpenChange={(open) => setIsVersionsDialogOpen(open)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={modalOverlayClassName} />
          <Dialog.Content
            className={[
              modalShellClassName,
              'max-w-[620px]',
            ].join(' ')}
          >
            <div className={modalHeaderClassName}>
              <div className="flex items-center space-x-2">
                <History className="w-4 h-4 text-primary" />
                <Dialog.Title className={modalIconTitleClassName}>Versions</Dialog.Title>
              </div>
              <Dialog.Close asChild>
                <button
                  className={modalCloseBtnClassName}
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
              {pipeVersions.length === 0 ? (
                <div className="text-[10px] text-textMain/40">No versions</div>
              ) : (
                pipeVersions.map((v) => (
                  <div key={v.version} className="border border-border bg-background/40 p-2 flex items-center justify-between gap-2">
                    <div className="flex-1">
                      <div className="text-[10px] text-textMain font-bold">v{v.version}</div>
                      <div className="text-[8px] text-textMain/40 font-mono truncate">{v.updated_at}</div>
                    </div>
                    <button
                      onClick={() => {
                        loadVersion(v.version);
                        setIsVersionsDialogOpen(false);
                      }}
                      className="btn-secondary !py-1.5 !px-3 touch-manipulation"
                    >
                      LOAD
                    </button>
                  </div>
                ))
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={isOpsDialogOpen}
        onOpenChange={(open) => setIsOpsDialogOpen(open)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={modalOverlayClassName} />
          <Dialog.Content
            className={[
              modalShellClassName,
              'max-w-[760px]',
            ].join(' ')}
          >
            <div className={modalHeaderClassName}>
              <div className="flex items-center space-x-2">
                <ScrollText className="w-4 h-4 text-primary" />
                <Dialog.Title className={modalIconTitleClassName}>Ops</Dialog.Title>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={openOps}
                  className="btn-secondary !py-1.5 !px-3 touch-manipulation"
                >
                  REFRESH
                </button>
                <Dialog.Close asChild>
                  <button
                    className={modalCloseBtnClassName}
                    aria-label="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </Dialog.Close>
              </div>
            </div>

            <div className="p-4 space-y-2 max-h-[70vh] overflow-y-auto">
              {pipeOps.length === 0 ? (
                <div className="text-[10px] text-textMain/40">No ops</div>
              ) : (
                pipeOps.map((op, idx) => (
                  <div key={`${op.ts}-${idx}`} className="border border-border bg-background/40 p-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[9px] text-textMain font-mono truncate">{op.kind}</div>
                      <div className="text-[8px] text-textMain/40 font-mono">{op.ts}</div>
                    </div>
                    {op.data != null && (
                      <div className="mt-1 text-[9px] text-textMain/40 font-mono break-all whitespace-pre-wrap">
                        {JSON.stringify(op.data)}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={isAutoSaveLogDialogOpen}
        onOpenChange={setIsAutoSaveLogDialogOpen}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={modalOverlayClassName} />
          <Dialog.Content
            className={[
              modalShellClassName,
              'max-w-[760px]',
            ].join(' ')}
          >
            <div className={modalHeaderClassName}>
              <div className="flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-primary" />
                <Dialog.Title className={modalIconTitleClassName}>Autosave Logs</Dialog.Title>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={clearAutoSaveLogs}
                  disabled={autoSaveLogs.length === 0}
                  className={[
                    'btn-secondary !py-1.5 !px-3 touch-manipulation',
                    autoSaveLogs.length === 0 ? 'opacity-40 cursor-not-allowed' : '',
                  ].join(' ')}
                >
                  CLEAR
                </button>
                <Dialog.Close asChild>
                  <button
                    className={modalCloseBtnClassName}
                    aria-label="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </Dialog.Close>
              </div>
            </div>

            <div className="p-4 space-y-2 max-h-[70vh] overflow-y-auto">
              {autoSaveLogs.length === 0 ? (
                <div className="text-[10px] text-textMain/40">No logs</div>
              ) : (
                autoSaveLogs.map((line, idx) => (
                  <div key={`${line}-${idx}`} className="border border-border bg-background/40 p-2">
                    <div className="text-[9px] text-textMain font-mono break-all whitespace-pre-wrap">{line}</div>
                  </div>
                ))
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={isConflictDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            // Cannot close conflict dialog by clicking outside or escape, must choose an action
            // But we allow if user really wants? No, better enforce choice.
            // For now allow close but it will pop up again on next autosave retry
            setIsConflictDialogOpen(false);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={modalOverlayClassName} />
          <Dialog.Content
            className={[
              modalShellClassName,
              'max-w-[500px] border-red-900/50',
            ].join(' ')}
          >
            <div className="p-4 border-b border-red-900/30 bg-red-950/20 flex items-center space-x-2">
              <div className="text-[11px] font-bold text-red-500 uppercase tracking-widest">Conflict Detected</div>
            </div>
            <div className="p-4 space-y-4">
              <div className="text-[10px] text-textMain/80">
                The pipeline has been modified on the server since you last loaded it.
              </div>
              <div className="border border-red-900/30 bg-red-950/10 p-3 space-y-2">
                <div className="flex justify-between">
                  <span className="text-[9px] uppercase font-bold text-textMain/40">Server Version</span>
                  <span className="text-[10px] font-mono text-textMain">v{conflictServerMeta?.version ?? '?'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[9px] uppercase font-bold text-textMain/40">Updated At</span>
                  <span className="text-[10px] font-mono text-textMain">{conflictServerMeta?.updated_at ?? '?'}</span>
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={reloadPipeFromServer}
                  className="px-3 py-2 border border-border text-[9px] uppercase font-bold hover:text-primary hover:bg-primary/10 transition-colors"
                >
                  Discard Local & Reload
                </button>
                <button
                  onClick={forceOverwritePipe}
                  className="px-3 py-2 bg-red-900/20 border border-red-900/50 text-red-500 text-[9px] uppercase font-bold hover:bg-red-900/40 transition-colors"
                >
                  Force Overwrite
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={isNodeDialogOpen} onOpenChange={setIsNodeDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={modalOverlayClassName} />
          <Dialog.Content
            className={[
              modalShellClassName,
              'max-w-[500px]',
            ].join(' ')}
          >
            <div className={modalHeaderClassName}>
              <div className="flex items-center space-x-2">
                <Settings2 className="w-4 h-4 text-primary" />
                <Dialog.Title className={modalIconTitleClassName}>Node Configuration</Dialog.Title>
              </div>
              <Dialog.Close asChild>
                <button className={modalCloseBtnClassName} aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </Dialog.Close>
            </div>
            
            <div className="p-6 space-y-5">
              <div className="space-y-1.5">
                <label className="text-[9px] text-textMain/60 uppercase font-bold tracking-wider">Label</label>
                <input
                  value={nodeDraft.label}
                  onChange={(e) => setNodeDraft((prev) => ({ ...prev, label: e.target.value }))}
                  className="w-full bg-background border border-border p-2 text-[10px] text-textMain font-bold focus:border-primary outline-none transition-colors"
                  placeholder="Node Label"
                />
              </div>

              {selectedNode?.type === 'sourceNode' && (
                <div className="space-y-4" data-testid="source-config-wizard">
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <button
                      onClick={() => setSourceType('registry')}
                      className={`
                        relative flex flex-col items-center gap-2 p-3 border rounded transition-all duration-300
                        ${sourceType === 'registry' 
                          ? 'border-primary bg-primary/10 text-primary shadow-[0_0_10px_rgba(0,255,65,0.1)]' 
                          : 'border-border bg-background/40 text-textMain/40 hover:border-primary/50 hover:text-textMain hover:bg-primary/5'}
                      `}
                    >
                      <Database className="w-5 h-5" />
                      <div className="flex flex-col items-center">
                        <span className="text-[10px] uppercase font-bold tracking-widest">Registry</span>
                        <span className="text-[8px] opacity-60 font-normal mt-0.5">Docker Hub / Private</span>
                      </div>
                      {sourceType === 'registry' && (
                        <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_5px_var(--primary-green)]" />
                      )}
                    </button>

                    <button
                      onClick={() => {
                        setSourceType('archive');
                        fetchArchives();
                      }}
                      className={`
                        relative flex flex-col items-center gap-2 p-3 border rounded transition-all duration-300
                        ${sourceType === 'archive' 
                          ? 'border-dim bg-dim/10 text-dim shadow-[0_0_10px_rgba(0,143,17,0.1)]' 
                          : 'border-border bg-background/40 text-textMain/40 hover:border-dim/50 hover:text-textMain hover:bg-primary/5'}
                      `}
                    >
                      <Archive className="w-5 h-5" />
                      <div className="flex flex-col items-center">
                        <span className="text-[10px] uppercase font-bold tracking-widest">Archive</span>
                        <span className="text-[8px] opacity-60 font-normal mt-0.5">Local Tarballs</span>
                      </div>
                      {sourceType === 'archive' && (
                        <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-dim shadow-[0_0_5px_var(--dim-green)]" />
                      )}
                    </button>
                  </div>

                  {sourceType === 'archive' ? (
                    <div className="border border-border bg-background/40 p-3 space-y-3">
                      <div className="text-[9px] uppercase font-bold text-textMain/60 tracking-wider mb-2">Select Archive</div>
                      {loadedArchives.length === 0 ? (
                        <div className="text-[10px] text-textMain/40 italic py-2">No archives found</div>
                      ) : (
                        <div className="max-h-[200px] overflow-y-auto space-y-1">
                          {loadedArchives.map((arc) => (
                            <div
                              key={arc.id}
                              onClick={() => {
                                const displayName = arc.name 
                                  ? (arc.tag ? `${arc.name}:${arc.tag}` : arc.name) 
                                  : arc.ref;
                                setNodeDraft((prev) => ({
                                  ...prev,
                                  image: arc.ref,
                                  archiveRef: arc.ref, // Stash logic
                                  displayImage: displayName,
                                }));
                              }}
                              className={`p-2 border cursor-pointer transition-colors ${
                                nodeDraft.image === arc.ref ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'
                              }`}
                            >
                              <div className="text-[10px] font-bold text-textMain break-all">
                                {arc.name ? (arc.tag ? `${arc.name}:${arc.tag}` : arc.name) : arc.ref}
                              </div>
                              <div className="flex gap-2 mt-1">
                                <span className="text-[8px] text-textMain/40 bg-background px-1 border border-border rounded">{arc.architecture || 'unknown'}</span>
                                <span className="text-[8px] text-textMain/40 bg-background px-1 border border-border rounded">{arc.os || 'unknown'}</span>
                                <span className="text-[8px] text-textMain/40 ml-auto">{(arc.size / 1024 / 1024).toFixed(1)} MB</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <RegistrySourceConfig
                      nodeId={selectedNode.id}
                      initialDraft={nodeDraft}
                      credentials={credentials}
                      onUpdateDraft={handleUpdateDraft}
                    />
                  )}
                </div>
              )}

              {selectedNode?.type === 'targetNode' && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-[9px] text-textMain/60 uppercase font-bold tracking-wider">Target Image Ref</label>
                    <div className="relative">
                      <Globe className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textMain/60" />
                      <input
                        value={nodeDraft.image}
                        onChange={(e) => setNodeDraft((prev) => ({ ...prev, image: e.target.value }))}
                        className="w-full bg-background border border-border !pl-9 !pr-3 !py-2.5 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                        placeholder="e.g. docker.io/user/repo:tag"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[9px] text-textMain/60 uppercase font-bold tracking-wider">Target Credential</label>
                    <div className="relative">
                      <Key className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textMain/60" />
                      <select
                        value={nodeDraft.credId}
                        onChange={(e) => setNodeDraft((prev) => ({ ...prev, credId: e.target.value }))}
                        className="w-full bg-background border border-border !pl-9 !pr-3 !py-2.5 text-[10px] text-textMain font-mono appearance-none focus:border-primary outline-none transition-colors"
                      >
                        <option value="">(No Credential)</option>
                        {credentials.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.registry})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}
              
              {selectedNode?.type !== 'sourceNode' && selectedNode?.type !== 'targetNode' && (
                <div className="space-y-1.5">
                  <label className="text-[9px] text-textMain/60 uppercase font-bold tracking-wider">Parameters</label>
                  <textarea
                    value={nodeDraft.params}
                    onChange={(e) => setNodeDraft((prev) => ({ ...prev, params: e.target.value }))}
                    placeholder='{"key":"value"}'
                    rows={6}
                    className="w-full bg-background border border-border p-2 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors resize-y"
                  />
                </div>
              )}
            </div>

            <div className="p-4 border-t border-border bg-panel flex justify-between">
              <button
                onClick={removeSelectedNode}
                className="px-4 py-2 border border-red-900/50 text-red-500 text-[9px] uppercase font-bold hover:bg-red-900/10 transition-colors touch-manipulation"
              >
                Delete Node
              </button>
              <div className="flex gap-2">
                <Dialog.Close asChild>
                  <button className="btn-secondary !py-2 !px-4 touch-manipulation">
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  onClick={saveNodeDraft}
                  className="btn-primary !py-2 !px-4 touch-manipulation"
                >
                  Apply Changes
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
};

export default Designer;
