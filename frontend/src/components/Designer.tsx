import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import ReactFlow, { 
  addEdge, 
  Background, 
  Controls, 
  type Connection, 
  type Edge,
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
import { Play, Save, Database, Filter, ArrowRight, Terminal, X, CheckCircle2, XCircle, Loader2, Settings2, Key, Trash2, ChevronRight, ChevronLeft, Plus, History, ScrollText, Copy, Download } from 'lucide-react';
import axios from 'axios';
import api from '../api';
import { classifyEdgeChanges, classifyNodeChanges } from './pipelineChangeClassifier';
import { computeExponentialBackoffMs, createDebouncedJob } from '../utils/debouncedJob';

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
  'bg-[#0d0d0d] border border-border shadow-2xl',
  'opacity-0 scale-95 transition-[opacity,transform] duration-200',
  'data-[state=open]:opacity-100 data-[state=open]:scale-100',
  'data-[state=closed]:opacity-0 data-[state=closed]:scale-95',
  'focus:outline-none',
].join(' ');
const modalHeaderClassName = 'p-4 border-b border-border bg-[#111] flex items-center justify-between';
const modalIconTitleClassName = 'text-[11px] font-bold text-primary uppercase tracking-[0.2em]';
const modalCloseBtnClassName =
  'p-1.5 border border-border text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation';

interface Credential {
  id: string;
  name: string;
  registry: string;
}

type NodeDraft = {
  label: string;
  image: string;
  credId: string;
  params: string;
};

type TargetRuntimeState = {
  targetRef: string;
  targetId?: string;
  status: string;
  progress: number;
  attempts: number;
  error?: string;
};

type TaskEvent =
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

type PipeMeta = {
  id: string;
  name: string;
  description?: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type PipeDTO = PipeMeta & {
  nodes: Node[];
  edges: Edge[];
};

type PipeVersion = {
  version: number;
  updated_at: string;
};

type PipeOp = {
  ts: string;
  kind: string;
  data?: unknown;
};

type SyncIndicatorState = 'idle' | 'syncing' | 'success' | 'error';
type SourceConfigStep = 1 | 2 | 3 | 4;

const Designer: React.FC = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
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
  const [sourceConfigStep, setSourceConfigStep] = useState<SourceConfigStep>(1);
  const [sourceRepoQuery, setSourceRepoQuery] = useState('');
  const [sourceTagQuery, setSourceTagQuery] = useState('');
  const [sourceNamespace, setSourceNamespace] = useState('');
  const [sourceRepositories, setSourceRepositories] = useState<string[]>([]);
  const [sourceTags, setSourceTags] = useState<string[]>([]);
  const [sourceSelectedRepo, setSourceSelectedRepo] = useState<string>('');
  const [sourceSelectedTag, setSourceSelectedTag] = useState<string>('');
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [isLoadingTags, setIsLoadingTags] = useState(false);
  const [repoLoadError, setRepoLoadError] = useState<string | null>(null);
  const [tagLoadError, setTagLoadError] = useState<string | null>(null);
  const reposCacheRef = useRef(new Map<string, { expiresAt: number; data: string[] }>());
  const tagsCacheRef = useRef(new Map<string, { expiresAt: number; data: string[] }>());
  const reposInFlightRef = useRef(new Map<string, Promise<string[]>>());
  const tagsInFlightRef = useRef(new Map<string, Promise<string[]>>());
  const sourceFetchTokenRef = useRef(0);
  const lastSourceDialogNodeIdRef = useRef<string | null>(null);
  const [didClearLogs, setDidClearLogs] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const restoredTaskIdRef = useRef<string | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [pipes, setPipes] = useState<PipeMeta[]>([]);
  const [pipeSearch, setPipeSearch] = useState('');
  const [showPipes, setShowPipes] = useState(localStorage.getItem('horcrux_show_pipes') !== 'false');
  const [pipeId, setPipeId] = useState<string | null>(null);
  const [pipeName, setPipeName] = useState<string>('NEW_PIPE_DESIGN');
  const [pipeDescription, setPipeDescription] = useState<string>('');
  const [pipeVersion, setPipeVersion] = useState<number>(0);
  const [pipeUpdatedAt, setPipeUpdatedAt] = useState<string | null>(null);
  const [isPipeDialogOpen, setIsPipeDialogOpen] = useState(false);
  const [pipeDraftName, setPipeDraftName] = useState('');
  const [pipeDraftDescription, setPipeDraftDescription] = useState('');
  const [isCreatePipeDialogOpen, setIsCreatePipeDialogOpen] = useState(false);
  const [createPipeError, setCreatePipeError] = useState<string | null>(null);
  const [isCreatingPipe, setIsCreatingPipe] = useState(false);
  const [isVersionsDialogOpen, setIsVersionsDialogOpen] = useState(false);
  const [pipeVersions, setPipeVersions] = useState<PipeVersion[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [isPipeLoading, setIsPipeLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isAutoSaving, setIsAutoSaving] = useState(false);
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<string | null>(null);
  const [autoSaveError, setAutoSaveError] = useState<string | null>(null);
  const [autoSaveLogs, setAutoSaveLogs] = useState<string[]>([]);
  const [isAutoSaveLogDialogOpen, setIsAutoSaveLogDialogOpen] = useState(false);
  const [isConflictDialogOpen, setIsConflictDialogOpen] = useState(false);
  const [conflictServerMeta, setConflictServerMeta] = useState<{ updated_at?: string; version?: number } | null>(null);
  const [isOpsDialogOpen, setIsOpsDialogOpen] = useState(false);
  const [pipeOps, setPipeOps] = useState<PipeOp[]>([]);
  const [isPipeMetaEditing, setIsPipeMetaEditing] = useState(false);
  const [metaTab, setMetaTab] = useState<'meta' | 'nodes' | 'edges'>('meta');
  const [metaSearch, setMetaSearch] = useState('');
  const [metaSort, setMetaSort] = useState<'key_asc' | 'key_desc'>('key_asc');
  const [metaListVisibleCount, setMetaListVisibleCount] = useState(60);
  const [isMetaPanelExpanded, setIsMetaPanelExpanded] = useState(() => {
    if (typeof window === 'undefined') return false;
    const raw = localStorage.getItem('horcrux_meta_panel_expanded');
    if (raw === null) return false;
    return raw === 'true';
  });
  const [isMetaDetailOpen, setIsMetaDetailOpen] = useState(false);
  const [metaDetailItem, setMetaDetailItem] = useState<{ key: string; value: string } | null>(null);
  const dirtyTokenRef = useRef(0);
  const autoSaveJobRef = useRef<ReturnType<typeof createDebouncedJob> | null>(null);
  const autoSaveRetryJobRef = useRef<ReturnType<typeof createDebouncedJob> | null>(null);
  const autoSaveRetryAttemptRef = useRef(0);
  const flushAutoSaveNowRef = useRef<(() => Promise<void>) | null>(null);
  const opsBufferRef = useRef<PipeOp[]>([]);
  const createPipeNameInputRef = useRef<HTMLInputElement | null>(null);
  const reactFlowApiRef = useRef<ReactFlowInstance | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const lastTaskLogCountRef = useRef(0);
  const logResizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const metaScrollRef = useRef<HTMLDivElement | null>(null);
  const [isMdUp, setIsMdUp] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.matchMedia?.('(min-width: 768px)')?.matches ?? true;
  });
  const [logPanelWidth, setLogPanelWidth] = useState(() => {
    if (typeof window === 'undefined') return 420;
    const raw = localStorage.getItem('horcrux_log_panel_width');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 420;
  });
  const [isResizingLogPanel, setIsResizingLogPanel] = useState(false);
  const [logSearch, setLogSearch] = useState('');
  const [logCategory, setLogCategory] = useState<'all' | 'target' | 'system'>('all');
  const [logLevelEnabled, setLogLevelEnabled] = useState<Record<'DEBUG' | 'INFO' | 'WARN' | 'ERROR', boolean>>({
    DEBUG: true,
    INFO: true,
    WARN: true,
    ERROR: true,
  });
  const [logVisibleCount, setLogVisibleCount] = useState(400);
  const [isLogPinnedToBottom, setIsLogPinnedToBottom] = useState(true);
  const [unseenLogCount, setUnseenLogCount] = useState(0);

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
    localStorage.setItem('horcrux_meta_panel_expanded', String(isMetaPanelExpanded));
  }, [isMetaPanelExpanded]);

  useEffect(() => {
    setLogVisibleCount(400);
  }, [logCategory, logSearch, logLevelEnabled.DEBUG, logLevelEnabled.INFO, logLevelEnabled.WARN, logLevelEnabled.ERROR]);

  const filteredTaskLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    const targetRefs = Object.keys(targetStates);
    const detectLevel = (line: string): 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | null => {
      const m = line.match(/\b(DEBUG|INFO|WARN|ERROR)\b/);
      if (!m) return null;
      return m[1] as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    };
    const detectCategory = (line: string): 'system' | 'target' => {
      for (const ref of targetRefs) {
        if (ref && line.includes(ref)) return 'target';
      }
      return 'system';
    };
    const out: string[] = [];
    for (const line of taskLogs) {
      const lvl = detectLevel(line);
      if (lvl && !logLevelEnabled[lvl]) continue;
      if (logCategory !== 'all') {
        const cat = detectCategory(line);
        if (cat !== logCategory) continue;
      }
      if (q && !line.toLowerCase().includes(q)) continue;
      out.push(line);
    }
    return out;
  }, [logCategory, logLevelEnabled, logSearch, targetStates, taskLogs]);

  const visibleTaskLogs = useMemo(() => {
    const total = filteredTaskLogs.length;
    const n = Math.max(0, Math.min(total, logVisibleCount));
    return filteredTaskLogs.slice(total - n);
  }, [filteredTaskLogs, logVisibleCount]);

  const toggleLogLevel = useCallback((level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR') => {
    setLogLevelEnabled((prev) => ({ ...prev, [level]: !prev[level] }));
  }, []);

  const scrollLogsToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = logScrollRef.current;
    if (!el) return;
    const targetTop = el.scrollHeight;
    try {
      el.scrollTo({ top: targetTop, behavior });
    } catch {
      el.scrollTop = targetTop;
    }
    setIsLogPinnedToBottom(true);
    setUnseenLogCount(0);
  }, []);

  useEffect(() => {
    if (!showLogs) return;
    requestAnimationFrame(() => scrollLogsToBottom('auto'));
  }, [scrollLogsToBottom, showLogs]);

  useEffect(() => {
    const prev = lastTaskLogCountRef.current;
    const now = taskLogs.length;
    lastTaskLogCountRef.current = now;
    if (!showLogs) return;
    if (now <= prev) return;
    if (isLogPinnedToBottom) {
      requestAnimationFrame(() => scrollLogsToBottom('auto'));
      return;
    }
    setUnseenLogCount((c) => c + (now - prev));
  }, [isLogPinnedToBottom, scrollLogsToBottom, showLogs, taskLogs.length]);

  const onLogScroll = useCallback(() => {
    const el = logScrollRef.current;
    if (!el) return;
    const threshold = 40;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    setIsLogPinnedToBottom(pinned);
    if (pinned) setUnseenLogCount(0);
    if (el.scrollTop <= 30) {
      const total = filteredTaskLogs.length;
      if (logVisibleCount < total) {
        setTimeout(() => setLogVisibleCount((v) => Math.min(total, v + 200)), 0);
      }
    }
  }, [filteredTaskLogs.length, logVisibleCount]);

  const copyVisibleLogs = useCallback(async () => {
    const text = visibleTaskLogs.join('\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.error('Copy failed:', e);
      alert('复制失败：浏览器不支持或权限不足');
    }
  }, [visibleTaskLogs]);

  const exportVisibleLogs = useCallback(() => {
    const text = visibleTaskLogs.join('\n');
    if (!text) return;
    const name = `task_${activeTaskId || 'none'}_${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [activeTaskId, visibleTaskLogs]);

  const startResizeLogPanel = useCallback((e: React.PointerEvent) => {
    if (!isMdUp) return;
    logResizeStartRef.current = { x: e.clientX, width: logPanelWidth };
    setIsResizingLogPanel(true);
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    e.preventDefault();
  }, [isMdUp, logPanelWidth]);

  useEffect(() => {
    if (!isResizingLogPanel) return;
    if (!isMdUp) return;
    const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
    const onMove = (e: PointerEvent) => {
      const start = logResizeStartRef.current;
      if (!start) return;
      const delta = start.x - e.clientX;
      const next = clamp(start.width + delta, 320, Math.floor(window.innerWidth * 0.7));
      setLogPanelWidth(next);
      localStorage.setItem('horcrux_log_panel_width', String(next));
    };
    const onUp = () => {
      setIsResizingLogPanel(false);
      logResizeStartRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [isMdUp, isResizingLogPanel]);

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
        { key: 'updated_at', value: pipeUpdatedAt || '-' },
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
  }, [edges, isAutoSaving, isDirty, lastAutoSavedAt, metaTab, nodes, pipeDescription, pipeId, pipeName, pipeUpdatedAt, pipeVersion]);

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

  const appendAutoSaveLog = useCallback((message: string) => {
    const line = `${new Date().toISOString()} ${message}`;
    setAutoSaveLogs((prev) => {
      const next = [line, ...prev];
      return next.length > 200 ? next.slice(0, 200) : next;
    });
  }, []);

  const markDirty = useCallback(() => {
    dirtyTokenRef.current += 1;
    setIsDirty(true);
    setAutoSaveError(null);
  }, []);

  const flushPipeOpsNow = useCallback(async () => {
    if (!pipeId) return;
    if (opsBufferRef.current.length === 0) return;
    const ops = opsBufferRef.current;
    opsBufferRef.current = [];
    try {
      await api.post(`/pipes/${pipeId}/ops`, ops);
    } catch (e) {
      console.error('Failed to append pipe ops:', e);
      opsBufferRef.current = ops.concat(opsBufferRef.current);
    }
  }, [pipeId]);

  const flushAutoSaveNow = useCallback(async () => {
    if (!pipeId) return;
    if (!isDirty) return;
    if (isSaving) return;
    const name = pipeName.trim();
    if (!name) return;

    const tokenAtStart = dirtyTokenRef.current;
    setIsAutoSaving(true);
    try {
      appendAutoSaveLog('autosave:start');
      await flushPipeOpsNow();
      const res = await api.put(`/pipes/${pipeId}`, {
        name,
        description: pipeDescription,
        nodes,
        edges,
      }, { params: { autosave: 1, base_updated_at: pipeUpdatedAt ?? undefined } });
      const out = res.data as Partial<PipeDTO>;
      if (typeof out.updated_at === 'string') setPipeUpdatedAt(out.updated_at);
      if (Number.isFinite(out.version)) setPipeVersion(Number(out.version));
      setLastAutoSavedAt(new Date().toISOString());
      setAutoSaveError(null);
      autoSaveRetryAttemptRef.current = 0;
      setConflictServerMeta(null);
      if (dirtyTokenRef.current === tokenAtStart) {
        setIsDirty(false);
      }
      appendAutoSaveLog('autosave:success');
    } catch (e) {
      const resp = ((): { status?: number; data?: unknown } | null => {
        if (!e || typeof e !== 'object') return null;
        if (!('response' in e)) return null;
        const r = (e as { response?: unknown }).response;
        if (!r || typeof r !== 'object') return null;
        const status = 'status' in r ? (r as { status?: unknown }).status : undefined;
        const data = 'data' in r ? (r as { data?: unknown }).data : undefined;
        return { status: typeof status === 'number' ? status : undefined, data };
      })();
      const status = resp?.status;
      if (status === 409) {
        const meta = resp?.data;
        const metaObj: Record<string, unknown> =
          meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
        const currentUpdatedAt =
          typeof metaObj.current_updated_at === 'string' ? metaObj.current_updated_at : undefined;
        const currentVersionRaw = metaObj.current_version;
        const currentVersion =
          typeof currentVersionRaw === 'number'
            ? currentVersionRaw
            : (typeof currentVersionRaw === 'string' ? Number(currentVersionRaw) : undefined);
        setConflictServerMeta({
          updated_at: currentUpdatedAt,
          version: Number.isFinite(currentVersion) ? currentVersion : undefined,
        });
        autoSaveRetryJobRef.current?.cancel();
        autoSaveRetryAttemptRef.current = 0;
        setIsConflictDialogOpen(true);
        setAutoSaveError('检测到并发修改冲突');
        appendAutoSaveLog('autosave:conflict');
        return;
      }
      console.error('Auto save failed:', e);
      setAutoSaveError('自动保存失败，将自动重试');
      appendAutoSaveLog('autosave:error');
      const attempt = autoSaveRetryAttemptRef.current;
      const delay = computeExponentialBackoffMs(attempt);
      autoSaveRetryAttemptRef.current = attempt + 1;
      if (!autoSaveRetryJobRef.current) {
        autoSaveRetryJobRef.current = createDebouncedJob(() => {
          flushAutoSaveNowRef.current?.().catch((err) => console.error('autosave retry failed:', err));
        });
      }
      autoSaveRetryJobRef.current.trigger(delay);
    } finally {
      setIsAutoSaving(false);
    }
  }, [appendAutoSaveLog, edges, flushPipeOpsNow, isDirty, isSaving, nodes, pipeDescription, pipeId, pipeName, pipeUpdatedAt]);

  const scheduleBackgroundSync = useCallback(() => {
    if (!autoSaveJobRef.current) {
      autoSaveJobRef.current = createDebouncedJob(() => {
        flushAutoSaveNowRef.current?.().catch((err) => console.error('flushAutoSaveNow failed:', err));
      });
    }
    autoSaveJobRef.current.trigger(500);
  }, []);

  const recordPipeOp = useCallback((kind: string, data?: unknown) => {
    if (!pipeId) return;
    opsBufferRef.current.push({ ts: new Date().toISOString(), kind, data });
    scheduleBackgroundSync();
  }, [pipeId, scheduleBackgroundSync]);

  useEffect(() => {
    flushAutoSaveNowRef.current = flushAutoSaveNow;
  }, [flushAutoSaveNow]);

  useEffect(() => {
    return () => {
      autoSaveJobRef.current?.cancel();
      autoSaveRetryJobRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  useEffect(() => {
    if (!showLogs) return;
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [showLogs, taskLogs.length]);

  useEffect(() => {
    localStorage.setItem('horcrux_show_pipes', String(showPipes));
  }, [showPipes]);

  const refreshPipes = useCallback(async () => {
    const res = await api.get('/pipes', { params: { meta_only: 1 } });
    const list = Array.isArray(res.data) ? (res.data as PipeMeta[]) : [];
    setPipes(list);
    return list;
  }, []);

  const applyLoadedPipe = useCallback((pipe: PipeDTO) => {
    setPipeId(pipe.id);
    setPipeName(pipe.name || 'NEW_PIPE_DESIGN');
    setPipeDescription(pipe.description || '');
    setPipeVersion(Number.isFinite(pipe.version) ? pipe.version : 0);
    setPipeUpdatedAt(pipe.updated_at || null);
    setNodes(Array.isArray(pipe.nodes) ? (pipe.nodes as Node[]) : []);
    setEdges(Array.isArray(pipe.edges) ? (pipe.edges as Edge[]) : []);
    setIsDirty(false);
    setIsPipeMetaEditing(false);
    setAutoSaveError(null);
    setConflictServerMeta(null);
    localStorage.setItem('horcrux_active_pipe_id', pipe.id);
  }, [setEdges, setNodes]);

  const loadPipeById = useCallback(async (id: string) => {
    setIsPipeLoading(true);
    try {
      const res = await api.get(`/pipes/${id}`);
      applyLoadedPipe(res.data as PipeDTO);
      return true;
    } catch (error) {
      console.error('Failed to load pipe:', error);
      localStorage.removeItem('horcrux_active_pipe_id');
      return false;
    } finally {
      setIsPipeLoading(false);
    }
  }, [applyLoadedPipe]);

  const resetToNewPipe = useCallback(() => {
    setPipeId(null);
    setPipeName('NEW_PIPE_DESIGN');
    setPipeDescription('');
    setPipeVersion(0);
    setPipeUpdatedAt(null);
    setNodes([]);
    setEdges([]);
    setIsDirty(false);
    setIsPipeMetaEditing(false);
    setAutoSaveError(null);
    setConflictServerMeta(null);
    localStorage.removeItem('horcrux_active_pipe_id');
  }, [setEdges, setNodes]);

  const selectPipe = useCallback(async (id: string) => {
    if (!id || id === pipeId) return;
    if (isDirty && !window.confirm('当前 Pipeline 还未保存，切换会丢失更改，是否继续？')) {
      return;
    }
    await loadPipeById(id);
    setIsPipeDialogOpen(false);
  }, [isDirty, loadPipeById, pipeId]);

  // 获取凭证列表和尝试加载最近的 Pipe
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
      setEdges((eds) => addEdge({ ...params, animated: true, style: { stroke: '#00ff41' } }, eds));
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

  const savePipe = async () => {
    const nextName = pipeName.trim();
    if (!nextName) {
      alert('ERROR: Pipeline 名称不能为空');
      return;
    }
    setIsSaving(true);
    try {
      await flushPipeOpsNow();
      const response = await api.post('/pipes', {
        id: pipeId,
        name: nextName,
        description: pipeDescription,
        nodes: nodes,
        edges: edges
      });
      applyLoadedPipe(response.data as PipeDTO);
      await refreshPipes();
      alert('SUCCESS: Pipeline 保存成功');
    } catch (error) {
      console.error('Failed to save pipe:', error);
      alert('ERROR: Pipeline 保存失败');
    } finally {
      setIsSaving(false);
    }
  };

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

  const saveNodeDraft = useCallback(() => {
    if (!selectedNode) return;
    updateNodeData(selectedNode.id, {
      label: nodeDraft.label,
      image: nodeDraft.image,
      credId: nodeDraft.credId,
      params: nodeDraft.params,
    });
    closeNodeDialog();
  }, [closeNodeDialog, nodeDraft.credId, nodeDraft.image, nodeDraft.label, nodeDraft.params, selectedNode, updateNodeData]);

  const getCachedList = useCallback((cache: Map<string, { expiresAt: number; data: string[] }>, key: string) => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  }, []);

  const setCachedList = useCallback((cache: Map<string, { expiresAt: number; data: string[] }>, key: string, data: string[], ttlMs: number) => {
    if (ttlMs <= 0) return;
    cache.set(key, { expiresAt: Date.now() + ttlMs, data });
  }, []);

  const getCredentialRegistry = useCallback((credId: string) => {
    const id = String(credId || '');
    const cred = credentials.find((c) => c.id === id);
    return cred?.registry ? String(cred.registry) : '';
  }, [credentials]);

  const normalizeRegistryHost = useCallback((registry: string) => {
    const raw = String(registry || '').trim();
    if (!raw) return '';
    return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  }, []);

  const isDockerHubHost = useCallback((host: string) => {
    const h = String(host || '').trim().toLowerCase();
    return h === '' || h === 'docker.io' || h === 'index.docker.io' || h === 'registry-1.docker.io';
  }, []);

  const buildSourceImageRef = useCallback((credId: string, repo: string, tag: string) => {
    const registry = normalizeRegistryHost(getCredentialRegistry(credId));
    const safeRepo = String(repo || '').trim();
    const safeTag = String(tag || '').trim();
    if (!safeRepo || !safeTag) return '';
    if (!registry || registry === 'docker.io' || registry === 'index.docker.io' || registry === 'registry-1.docker.io') {
      return `${safeRepo}:${safeTag}`;
    }
    return `${registry}/${safeRepo}:${safeTag}`;
  }, [getCredentialRegistry, normalizeRegistryHost]);

  const parseImageRef = useCallback((ref: string) => {
    let s = String(ref || '').trim();
    if (!s) return { registry: '', repo: '', tag: '' };
    const at = s.indexOf('@');
    if (at >= 0) s = s.slice(0, at);
    const lastSlash = s.lastIndexOf('/');
    const lastColon = s.lastIndexOf(':');
    const hasTag = lastColon > lastSlash;
    const tag = hasTag ? s.slice(lastColon + 1) : '';
    const withoutTag = hasTag ? s.slice(0, lastColon) : s;

    const firstSlash = withoutTag.indexOf('/');
    if (firstSlash > 0) {
      const first = withoutTag.slice(0, firstSlash);
      if (first.includes('.') || first.includes(':') || first === 'localhost') {
        return { registry: first, repo: withoutTag.slice(firstSlash + 1), tag };
      }
    }
    return { registry: '', repo: withoutTag, tag };
  }, []);

  const sleep = useCallback((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)), []);

  const shouldRetryRegistryQuery = useCallback((e: unknown) => {
    if (!axios.isAxiosError(e)) return false;
    const status = e.response?.status;
    if (!status) return true;
    return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
  }, []);

  const formatRegistryQueryError = useCallback((e: unknown, fallback: string) => {
    if (!axios.isAxiosError(e)) {
      const msg = e instanceof Error ? e.message : String(e);
      const safe = msg && msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
      return safe ? `${fallback}（${safe}）` : fallback;
    }

    const status = e.response?.status;
    const data = e.response?.data as unknown;
    const maybeRecord = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
    const serverError = maybeRecord && typeof maybeRecord.error === 'string' ? maybeRecord.error : '';
    const upstreamStatus = maybeRecord && typeof maybeRecord.upstream_status === 'number' ? maybeRecord.upstream_status : 0;
    const detail = maybeRecord && typeof maybeRecord.detail === 'string' ? maybeRecord.detail : '';

    const parts: string[] = [];
    if (serverError) parts.push(serverError);
    if (detail) parts.push(detail);
    const joined = parts.join('：');
    const trimmed = joined.length > 180 ? joined.slice(0, 180) + '…' : joined;

    if (status) {
      const extra = upstreamStatus ? ` / Upstream ${upstreamStatus}` : '';
      return trimmed ? `${fallback}（HTTP ${status}${extra}：${trimmed}）` : `${fallback}（HTTP ${status}${extra}）`;
    }
    return trimmed ? `${fallback}（${trimmed}）` : fallback;
  }, []);

  const requestWithRetryStringList = useCallback(async (
    fn: () => Promise<string[]>,
    opts: { retries: number; baseDelayMs: number },
  ) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt >= opts.retries || !shouldRetryRegistryQuery(e)) break;
        await sleep(computeExponentialBackoffMs(opts.baseDelayMs, attempt));
      }
    }
    throw lastErr;
  }, [shouldRetryRegistryQuery, sleep]);

  const fetchRepositoriesByCred = useCallback(async (credId: string, namespace?: string) => {
    const id = String(credId || '').trim();
    if (!id) return [];
    const ns = String(namespace || '').trim().toLowerCase();
    const cacheKey = `repos|${id}|${ns}`;
    const cached = getCachedList(reposCacheRef.current, cacheKey);
    if (cached) return cached;
    const inflight = reposInFlightRef.current.get(cacheKey);
    if (inflight) return inflight;

    const p = requestWithRetryStringList(
      () => api.get('/registry/repositories', { params: ns ? { cred_id: id, namespace: ns } : { cred_id: id } }).then((res) => {
        const list = Array.isArray(res.data?.repositories) ? (res.data.repositories as string[]) : [];
        setCachedList(reposCacheRef.current, cacheKey, list, 3 * 60 * 1000);
        return list;
      }),
      { retries: 1, baseDelayMs: 380 },
    ).finally(() => {
      reposInFlightRef.current.delete(cacheKey);
    });
    reposInFlightRef.current.set(cacheKey, p);
    return p;
  }, [getCachedList, requestWithRetryStringList, setCachedList]);

  const fetchTagsByRepo = useCallback(async (credId: string, repo: string) => {
    const id = String(credId || '').trim();
    const r = String(repo || '').trim();
    if (!id || !r) return [];
    const cacheKey = `tags|${id}|${r}`;
    const cached = getCachedList(tagsCacheRef.current, cacheKey);
    if (cached) return cached;
    const inflight = tagsInFlightRef.current.get(cacheKey);
    if (inflight) return inflight;

    const p = requestWithRetryStringList(
      () => api.get('/registry/tags', { params: { cred_id: id, repo: r } }).then((res) => {
        const list = Array.isArray(res.data?.tags) ? (res.data.tags as string[]) : [];
        setCachedList(tagsCacheRef.current, cacheKey, list, 2 * 60 * 1000);
        return list;
      }),
      { retries: 1, baseDelayMs: 380 },
    ).finally(() => {
      tagsInFlightRef.current.delete(cacheKey);
    });
    tagsInFlightRef.current.set(cacheKey, p);
    return p;
  }, [getCachedList, requestWithRetryStringList, setCachedList]);

  const resetSourceWizard = useCallback((imageRef: string, credId: string) => {
    const parsed = parseImageRef(imageRef);
    setSourceSelectedRepo(parsed.repo);
    setSourceSelectedTag(parsed.tag);
    setSourceNamespace('');
    setSourceRepositories([]);
    setSourceTags([]);
    setRepoLoadError(null);
    setTagLoadError(null);
    setIsLoadingRepos(false);
    setIsLoadingTags(false);
    setSourceRepoQuery('');
    setSourceTagQuery('');
    setSourceConfigStep(1);
    if (String(credId || '').trim()) {
      setSourceConfigStep(2);
    }
  }, [parseImageRef]);

  const loadRepositoriesForSource = useCallback(async (credId: string, namespace?: string) => {
    const id = String(credId || '').trim();
    if (!id) return;
    const token = ++sourceFetchTokenRef.current;
    setIsLoadingRepos(true);
    setRepoLoadError(null);
    try {
      const list = await fetchRepositoriesByCred(id, namespace);
      if (sourceFetchTokenRef.current !== token) return;
      setSourceRepositories(list);
    } catch (e) {
      if (sourceFetchTokenRef.current !== token) return;
      setRepoLoadError(formatRegistryQueryError(e, '镜像仓库列表查询失败'));
      setSourceRepositories([]);
    } finally {
      if (sourceFetchTokenRef.current === token) {
        setIsLoadingRepos(false);
      }
    }
  }, [fetchRepositoriesByCred, formatRegistryQueryError]);

  const loadTagsForSource = useCallback(async (credId: string, repo: string) => {
    const id = String(credId || '').trim();
    const r = String(repo || '').trim();
    if (!id || !r) return;
    const token = ++sourceFetchTokenRef.current;
    setIsLoadingTags(true);
    setTagLoadError(null);
    try {
      const list = await fetchTagsByRepo(id, r);
      if (sourceFetchTokenRef.current !== token) return;
      setSourceTags(list);
    } catch (e) {
      if (sourceFetchTokenRef.current !== token) return;
      setTagLoadError(formatRegistryQueryError(e, '版本标签查询失败'));
      setSourceTags([]);
    } finally {
      if (sourceFetchTokenRef.current === token) {
        setIsLoadingTags(false);
      }
    }
  }, [fetchTagsByRepo, formatRegistryQueryError]);

  useEffect(() => {
    if (!isNodeDialogOpen || selectedNode?.type !== 'sourceNode') {
      lastSourceDialogNodeIdRef.current = null;
      return;
    }
    if (lastSourceDialogNodeIdRef.current === selectedNode.id) return;
    lastSourceDialogNodeIdRef.current = selectedNode.id;
    resetSourceWizard(nodeDraft.image, nodeDraft.credId);
  }, [isNodeDialogOpen, nodeDraft.credId, nodeDraft.image, resetSourceWizard, selectedNode?.id, selectedNode?.type]);

  useEffect(() => {
    if (!isNodeDialogOpen) return;
    if (selectedNode?.type !== 'sourceNode') return;
    const id = String(nodeDraft.credId || '').trim();
    if (!id) {
      setSourceConfigStep(1);
      setSourceRepositories([]);
      setRepoLoadError(null);
      setIsLoadingRepos(false);
      return;
    }
    setSourceConfigStep(2);
    const host = normalizeRegistryHost(getCredentialRegistry(id));
    if (isDockerHubHost(host)) {
      setSourceRepositories([]);
      setRepoLoadError(null);
      setIsLoadingRepos(false);
      return;
    }
    loadRepositoriesForSource(id);
  }, [getCredentialRegistry, isDockerHubHost, isNodeDialogOpen, loadRepositoriesForSource, nodeDraft.credId, normalizeRegistryHost, selectedNode?.type]);

  useEffect(() => {
    if (!isNodeDialogOpen) return;
    if (selectedNode?.type !== 'sourceNode') return;
    if (sourceConfigStep !== 4) return;
    const id = String(nodeDraft.credId || '').trim();
    const repo = String(sourceSelectedRepo || '').trim();
    if (!id || !repo) return;
    loadTagsForSource(id, repo);
  }, [isNodeDialogOpen, loadTagsForSource, nodeDraft.credId, selectedNode?.type, sourceConfigStep, sourceSelectedRepo]);

  useEffect(() => {
    if (selectedNode?.type !== 'sourceNode') return;
    if (!sourceSelectedRepo || !sourceSelectedTag) return;
    const nextImage = buildSourceImageRef(nodeDraft.credId, sourceSelectedRepo, sourceSelectedTag);
    if (!nextImage) return;
    setNodeDraft((prev) => (prev.image === nextImage ? prev : { ...prev, image: nextImage }));
  }, [buildSourceImageRef, nodeDraft.credId, selectedNode?.type, sourceSelectedRepo, sourceSelectedTag]);

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

  const createPipe = useCallback(async () => {
    const name = pipeDraftName.trim();
    const description = pipeDraftDescription.trim();
    if (!name) {
      setCreatePipeError('Pipeline 名称不能为空');
      window.setTimeout(() => createPipeNameInputRef.current?.focus(), 0);
      return;
    }
    setCreatePipeError(null);
    setIsCreatingPipe(true);
    try {
      const res = await api.post('/pipes', { name, description, nodes: [], edges: [] });
      applyLoadedPipe(res.data as PipeDTO);
      setPipeDraftName('');
      setPipeDraftDescription('');
      await refreshPipes();
      setPipeSearch('');
      setIsCreatePipeDialogOpen(false);
    } catch (e) {
      console.error('Failed to create pipe:', e);
      setCreatePipeError('Pipeline 创建失败');
    } finally {
      setIsCreatingPipe(false);
    }
  }, [applyLoadedPipe, pipeDraftDescription, pipeDraftName, refreshPipes]);

  const deletePipeById = useCallback(async (id: string) => {
    if (!id) return;
    if (!window.confirm('确认删除该 Pipeline？此操作不可恢复')) return;
    try {
      await api.delete(`/pipes/${id}`);
      const list = await refreshPipes();
      if (pipeId === id) {
        const nextId = list[0]?.id ?? null;
        if (nextId) {
          await loadPipeById(nextId);
        } else {
          resetToNewPipe();
        }
      }
    } catch (e) {
      console.error('Failed to delete pipe:', e);
      alert('ERROR: Pipeline 删除失败');
    }
  }, [loadPipeById, pipeId, refreshPipes, resetToNewPipe]);

  const openVersions = useCallback(async () => {
    if (!pipeId) return;
    try {
      const res = await api.get(`/pipes/${pipeId}/versions`);
      const list = Array.isArray(res.data) ? (res.data as PipeVersion[]) : [];
      setPipeVersions(list);
      setIsVersionsDialogOpen(true);
    } catch (e) {
      console.error('Failed to open versions:', e);
      alert('ERROR: 版本列表获取失败');
    }
  }, [pipeId]);

  const openAutoSaveLogs = useCallback(() => {
    setIsAutoSaveLogDialogOpen(true);
  }, []);

  const clearAutoSaveLogs = useCallback(() => {
    setAutoSaveLogs([]);
  }, []);

  const reloadPipeFromServer = useCallback(async () => {
    if (!pipeId) return;
    appendAutoSaveLog('conflict:reload');
    setIsConflictDialogOpen(false);
    await loadPipeById(pipeId);
  }, [appendAutoSaveLog, loadPipeById, pipeId]);

  const forceOverwritePipe = useCallback(async () => {
    if (!pipeId) return;
    if (isSaving || isAutoSaving) return;
    const name = pipeName.trim();
    if (!name) return;

    const tokenAtStart = dirtyTokenRef.current;
    setIsAutoSaving(true);
    try {
      appendAutoSaveLog('conflict:force_overwrite:start');
      await flushPipeOpsNow();
      const res = await api.put(`/pipes/${pipeId}`, {
        name,
        description: pipeDescription,
        nodes,
        edges,
      }, { params: { autosave: 1, force: 1, base_updated_at: pipeUpdatedAt ?? undefined } });
      const out = res.data as Partial<PipeDTO>;
      if (typeof out.updated_at === 'string') setPipeUpdatedAt(out.updated_at);
      if (Number.isFinite(out.version)) setPipeVersion(Number(out.version));
      setLastAutoSavedAt(new Date().toISOString());
      setAutoSaveError(null);
      setConflictServerMeta(null);
      setIsConflictDialogOpen(false);
      autoSaveRetryAttemptRef.current = 0;
      if (dirtyTokenRef.current === tokenAtStart) {
        setIsDirty(false);
      }
      appendAutoSaveLog('conflict:force_overwrite:success');
    } catch (e) {
      console.error('Force overwrite failed:', e);
      setAutoSaveError('强制覆盖失败');
      appendAutoSaveLog('conflict:force_overwrite:error');
    } finally {
      setIsAutoSaving(false);
    }
  }, [appendAutoSaveLog, edges, flushPipeOpsNow, isAutoSaving, isSaving, nodes, pipeDescription, pipeId, pipeName, pipeUpdatedAt]);

  const openOps = useCallback(async () => {
    if (!pipeId) return;
    try {
      const res = await api.get(`/pipes/${pipeId}/ops`, { params: { limit: 200 } });
      const list = Array.isArray(res.data) ? (res.data as PipeOp[]) : [];
      setPipeOps(list);
      setIsOpsDialogOpen(true);
      setIsPipeDialogOpen(false);
    } catch (e) {
      console.error('Failed to load ops:', e);
      alert('ERROR: 获取操作历史失败');
    }
  }, [pipeId]);

  const loadVersion = useCallback(async (version: number) => {
    if (!pipeId) return;
    try {
      const res = await api.get(`/pipes/${pipeId}/versions/${version}`);
      applyLoadedPipe(res.data as PipeDTO);
      setIsVersionsDialogOpen(false);
      alert(`SUCCESS: 已加载版本 v${version}`);
    } catch (e) {
      console.error('Failed to load version:', e);
      alert('ERROR: 加载版本失败');
    }
  }, [applyLoadedPipe, pipeId]);

  // WebSocket 实时日志处理
  useEffect(() => {
    if (!activeTaskId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    
    ws.onopen = () => {
      console.log('WS: Connected for task', activeTaskId);
    };

    ws.onmessage = (event) => {
      const data = event.data as string;
      if (data.startsWith(`TASK_LOG:${activeTaskId}:`)) {
        const log = data.replace(`TASK_LOG:${activeTaskId}:`, '');
        setTaskLogs(prev => {
          // 避免重复日志（简单判断）
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
      setTaskLogs((prev) => [...prev, 'ERROR: 取消请求失败，请检查网络连接或后端状态']);
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
      setTaskLogs((prev) => [...prev, 'ERROR: 重试请求失败，请检查网络连接或后端状态']);
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
    // 简单的逻辑：从 edges 中找到连接 source 和 target 的路径
    // 目前简化处理：直接寻找图中的 sourceNode 和 targetNode
    const sourceNode = nodes.find(n => n.type === 'sourceNode');
    const targetNodes = nodes.filter(n => n.type === 'targetNode');

    if (!sourceNode || targetNodes.length === 0) {
      alert('请确保画布中至少有一个源节点(Source)和一个目标节点(Target)');
      return;
    }

    const missingTarget = targetNodes.find((n) => !n.data?.image);
    if (!sourceNode.data.image || missingTarget) {
      alert('请先配置源镜像和目标镜像名称');
      setSelectedNode(sourceNode.data.image ? missingTarget || targetNodes[0] : sourceNode);
      return;
    }

    setIsSyncing(true);
    setTaskLogs([]);
    setTaskStatus('running');
    setShowLogs(true);
    setTaskCancelRequested(false);
    
    try {
      const response = await api.post('/tasks/sync', {
        source_ref: sourceNode.data.image,
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
      setTaskLogs(prev => [...prev, 'ERROR: 任务启动失败，请检查网络连接或后端状态']);
    }
  };

  const renderedEdges = useMemo(() => {
    if (!isSyncing) return edges;
    const markerEnd = { type: MarkerType.ArrowClosed, color: '#00ff41' as const };
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
        >
          <Background
            variant={BackgroundVariant.Lines}
            color="#222"
            gap={30}
            size={1}
          />
          <Controls className="!bg-[#111] !border-border !fill-primary" />
          
          <Panel position="top-left" className="flex space-x-2">
            <div className="flex flex-col space-y-2">
              <div className="bg-[#0d0d0d] border border-border p-1 flex space-x-1">
                <button 
                  onClick={() => addNode('sourceNode')}
                  className="p-2 hover:bg-primary/10 active:bg-primary/10 text-[#666] hover:text-primary transition-colors touch-manipulation"
                  title="Add Source"
                >
                  <Database className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => addNode('processorNode')}
                  className="p-2 hover:bg-primary/10 active:bg-primary/10 text-[#666] hover:text-primary transition-colors touch-manipulation"
                  title="Add Processor"
                >
                  <Filter className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => addNode('targetNode')}
                  className="p-2 hover:bg-primary/10 active:bg-primary/10 text-[#666] hover:text-primary transition-colors touch-manipulation"
                  title="Add Target"
                >
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowPipes((v) => !v)}
                  className="p-2 hover:bg-primary/10 active:bg-primary/10 text-[#666] hover:text-primary transition-colors touch-manipulation"
                  title={showPipes ? 'Hide Pipelines' : 'Show Pipelines'}
                >
                  <ChevronLeft className={`w-4 h-4 transition-transform ${showPipes ? 'rotate-180' : ''}`} />
                </button>
              </div>

              {showPipes && (
                <div className="bg-[#0d0d0d] border border-border px-2 py-1.5 flex items-center gap-2">
                  <button
                    onClick={openPipeManager}
                    className="flex-1 text-left text-[9px] uppercase font-bold tracking-widest text-[#666] hover:text-primary transition-colors truncate"
                    title="Manage Pipelines"
                  >
                    {pipeName || 'NEW_PIPE_DESIGN'}
                    {isDirty ? ' *' : ''}
                    {pipeVersion > 0 ? ` v${pipeVersion}` : ''}
                    {isPipeLoading ? ' ...' : ''}
                  </button>
                  <button
                    onClick={() => {
                      if (isDirty && !window.confirm('当前 Pipeline 还未保存，创建新 Pipeline 会丢失更改，是否继续？')) return;
                      setPipeDraftName('');
                      setPipeDraftDescription('');
                      openPipeManager();
                    }}
                    className="p-1.5 border border-border text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation"
                    title="New Pipeline"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={openVersions}
                    disabled={!pipeId}
                    className={[
                      'p-1.5 border border-border transition-colors touch-manipulation',
                      pipeId ? 'text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10' : 'opacity-40 cursor-not-allowed text-[#444]',
                    ].join(' ')}
                    title="Versions"
                  >
                    <History className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={openOps}
                    disabled={!pipeId}
                    className={[
                      'p-1.5 border border-border transition-colors touch-manipulation',
                      pipeId ? 'text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10' : 'opacity-40 cursor-not-allowed text-[#444]',
                    ].join(' ')}
                    title="Ops"
                  >
                    <ScrollText className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={openAutoSaveLogs}
                    className={[
                      'p-1.5 border border-border transition-colors touch-manipulation',
                      autoSaveError ? 'text-red-500 hover:bg-red-500/10 active:bg-red-500/10' : 'text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10',
                    ].join(' ')}
                    title={autoSaveError ? autoSaveError : 'Autosave Logs'}
                  >
                    <Terminal className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
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
            title={!isSaving && !isDirty && !isAutoSaving ? '已自动保存' : '保存 Pipeline'}
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

          <Panel position="bottom-left" className="pointer-events-auto">
            <div
              className={[
                'border border-border bg-[#0d0d0d]/90 backdrop-blur-sm',
                'w-[calc(100vw-28px)] max-w-[620px] md:max-w-none',
                isMetaPanelExpanded ? 'md:w-[520px]' : 'md:w-[64px]',
              ].join(' ')}
              data-testid="pipe-metadata-panel"
              role="region"
              aria-label="Pipe 元数据面板"
            >
              <div className="p-3 border-b border-border bg-[#111] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <h4 className="text-[11px] font-bold text-primary uppercase tracking-widest truncate">Pipe_Metadata</h4>
                  {isDirty && <span className="text-[10px] text-yellow-400 font-bold">DIRTY</span>}
                </div>
                <button
                  onClick={() => setIsMetaPanelExpanded((v) => !v)}
                  className="p-1.5 border border-border text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-primary/40"
                  title={isMetaPanelExpanded ? 'Collapse' : 'Expand'}
                  aria-expanded={isMetaPanelExpanded}
                  aria-controls="pipe-meta-body"
                >
                  {isMetaPanelExpanded ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
              </div>

              <div
                id="pipe-meta-body"
                className={[
                  'overflow-hidden transition-[max-height,opacity] duration-200 ease-out',
                  isMetaPanelExpanded ? 'max-h-[70vh] opacity-100' : 'max-h-0 opacity-0 pointer-events-none',
                ].join(' ')}
              >
                <div className="p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="inline-flex border border-border bg-black/40" role="tablist" aria-label="元数据视图切换">
                      {(['meta', 'nodes', 'edges'] as const).map((t) => (
                        <button
                          key={t}
                          onClick={() => {
                            setMetaTab(t);
                            setMetaListVisibleCount(60);
                            metaScrollRef.current?.scrollTo({ top: 0 });
                          }}
                          className={[
                            'px-2 py-1 text-[9px] uppercase font-bold transition-colors touch-manipulation',
                            metaTab === t ? 'text-primary bg-primary/10' : 'text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10',
                          ].join(' ')}
                          role="tab"
                          aria-selected={metaTab === t}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <input
                      value={metaSearch}
                      onChange={(e) => {
                        setMetaSearch(e.target.value);
                        setMetaListVisibleCount(60);
                        metaScrollRef.current?.scrollTo({ top: 0 });
                      }}
                      className="flex-1 min-w-[180px] bg-black border border-border px-2 py-1.5 text-[10px] text-textMain focus:border-primary outline-none transition-colors focus:ring-2 focus:ring-primary/30"
                      placeholder="搜索 key / value"
                      aria-label="搜索元数据"
                    />
                    <button
                      onClick={() => setMetaSort((v) => (v === 'key_asc' ? 'key_desc' : 'key_asc'))}
                      className="px-2 py-1 border border-border text-[9px] uppercase font-bold transition-colors touch-manipulation text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10 focus:outline-none focus:ring-2 focus:ring-primary/40"
                      title="Sort"
                      aria-label="切换排序"
                    >
                      {metaSort === 'key_asc' ? 'A->Z' : 'Z->A'}
                    </button>
                  </div>

                  <div
                    ref={metaScrollRef}
                    onScroll={onMetaScroll}
                    className="max-h-[40vh] md:max-h-[420px] overflow-y-auto border border-border bg-black/40"
                    role="list"
                    aria-label="元数据列表"
                  >
                    <div className="p-2 space-y-1">
                      {visibleMetaItems.length === 0 ? (
                        <div className="text-[10px] text-[#444]">No data</div>
                      ) : (
                        visibleMetaItems.map((it) => (
                          <div
                            key={it.key}
                            className="group grid grid-cols-1 md:grid-cols-[120px_1fr] gap-2 border border-border/50 bg-black/40 px-2 py-2 hover:border-primary/30 hover:bg-primary/5 transition-colors"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={[
                                  'inline-flex h-1.5 w-1.5 rounded-full',
                                  it.key === 'name' ? 'bg-primary' :
                                  it.key === 'id' ? 'bg-blue-400' :
                                  it.key === 'version' ? 'bg-purple-400' :
                                  it.key === 'updated_at' ? 'bg-cyan-400' :
                                  it.key === 'autosave' ? 'bg-green-400' :
                                  it.key === 'dirty' ? 'bg-yellow-400' :
                                  'bg-[#444]',
                                ].join(' ')}
                                aria-hidden="true"
                              />
                              <div className="text-[10px] text-[#666] font-mono break-all uppercase tracking-wider">
                                {it.key}
                              </div>
                              {(it.key === 'name' || it.key === 'version' || it.key === 'updated_at') && (
                                <span className="ml-auto px-1.5 py-0.5 border border-border text-[8px] uppercase font-bold text-[#666] bg-black/40">
                                  KEY
                                </span>
                              )}
                            </div>
                            <div className="flex items-start gap-2 min-w-0">
                              <div
                                className={[
                                  'text-[10px] text-textMain font-mono break-all',
                                  (it.value.length > 80 || it.value.includes('\n')) ? 'hx-clamp-2' : '',
                                ].join(' ')}
                                title={it.value}
                              >
                                {it.value}
                              </div>
                              {(it.value.length > 80 || it.value.includes('\n')) && (
                                <button
                                  onClick={() => {
                                    setMetaDetailItem(it);
                                    setIsMetaDetailOpen(true);
                                  }}
                                  className="shrink-0 px-2 py-1 border border-border text-[9px] uppercase font-bold text-[#666] bg-black/40 hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                  aria-label={`查看 ${it.key} 完整内容`}
                                  title="查看完整内容"
                                >
                                  展开
                                </button>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                      {metaListVisibleCount < filteredMetaItems.length && (
                        <button
                          onClick={() => setMetaListVisibleCount((v) => Math.min(filteredMetaItems.length, v + 120))}
                          className="w-full mt-2 px-2 py-2 border border-border text-[9px] uppercase font-bold transition-colors touch-manipulation text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10 focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                          LOAD_MORE ({filteredMetaItems.length - metaListVisibleCount})
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

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
                    <div className="border border-border bg-black/40 p-3">
                      <div className="text-[9px] text-[#666] uppercase font-bold tracking-wider">KEY</div>
                      <div className="mt-1 text-[11px] text-textMain font-mono break-all">{metaDetailItem?.key || '-'}</div>
                    </div>
                    <div className="border border-border bg-black/40 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[9px] text-[#666] uppercase font-bold tracking-wider">VALUE</div>
                        <button
                          onClick={async () => {
                            const v = metaDetailItem?.value || '';
                            if (!v) return;
                            try {
                              await navigator.clipboard.writeText(v);
                            } catch (e) {
                              console.error('Copy failed:', e);
                              alert('复制失败：浏览器不支持或权限不足');
                            }
                          }}
                          className="p-1.5 border border-border text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-primary/40"
                          title="Copy"
                          aria-label="复制 value"
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
          </Panel>
        </ReactFlow>
      </div>

      <div
        className={[
          'border-l border-border bg-[#0d0d0d] flex flex-col overflow-hidden transition-all duration-200 relative',
          'w-full md:w-auto',
          showLogs ? 'max-h-[40vh] md:max-h-none' : 'max-h-0 md:w-0',
        ].join(' ')}
        style={isMdUp ? { width: showLogs ? logPanelWidth : 0 } : undefined}
      >
        {showLogs && isMdUp && (
          <div
            onPointerDown={startResizeLogPanel}
            className={[
              'absolute left-0 top-0 h-full w-1.5 cursor-col-resize select-none',
              'bg-transparent hover:bg-primary/20 active:bg-primary/30',
              isResizingLogPanel ? 'bg-primary/30' : '',
            ].join(' ')}
            style={{ transform: 'translateX(-50%)' }}
            role="separator"
            aria-orientation="vertical"
          />
        )}
        <div className="p-3 border-b border-border bg-[#111] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Terminal className="w-3.5 h-3.5 text-primary" />
            <span className="text-[10px] font-bold text-primary uppercase tracking-widest">Live_Task_Log</span>
            {taskStatus === 'running' && <span className="flex h-1.5 w-1.5 rounded-full bg-primary animate-pulse"></span>}
          </div>
          <div className="flex items-center space-x-2">
            {activeTaskId && taskStatus === 'running' && (
              <button
                onClick={cancelTask}
                disabled={taskCancelRequested}
                className={[
                  'px-2 py-1 border border-border text-[9px] uppercase font-bold transition-colors touch-manipulation flex items-center space-x-1',
                  taskCancelRequested ? 'opacity-60 cursor-not-allowed text-[#666]' : 'text-[#666] hover:text-red-400 hover:bg-red-500/10 active:bg-red-500/10',
                ].join(' ')}
                title="Cancel"
              >
                <X className="w-3 h-3" />
                <span>{taskCancelRequested ? 'CANCELING...' : 'CANCEL'}</span>
              </button>
            )}
            {activeTaskId && taskStatus !== 'running' && taskStatus !== 'idle' && (
              <button
                onClick={retryFailedTargets}
                className="px-2 py-1 border border-border text-[9px] uppercase font-bold transition-colors touch-manipulation flex items-center space-x-1 text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10"
                title="Retry Failed"
              >
                <Play className="w-3 h-3" />
                <span>RETRY_FAILED</span>
              </button>
            )}
            <button
              onClick={clearLogs}
              disabled={taskLogs.length === 0}
              className={[
                'px-2 py-1 border border-border text-[9px] uppercase font-bold transition-colors touch-manipulation flex items-center space-x-1',
                taskLogs.length === 0 ? 'opacity-40 cursor-not-allowed text-[#444]' : 'text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10',
                didClearLogs ? '!text-primary !border-primary/40 !bg-primary/10' : '',
              ].join(' ')}
              title="Clear Logs"
            >
              <Trash2 className="w-3 h-3" />
              <span>{didClearLogs ? 'CLEARED' : 'CLEAR'}</span>
            </button>
            <button
              onClick={copyVisibleLogs}
              disabled={visibleTaskLogs.length === 0}
              className={[
                'p-1.5 border border-border transition-colors touch-manipulation',
                visibleTaskLogs.length === 0 ? 'opacity-40 cursor-not-allowed text-[#444]' : 'text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10',
              ].join(' ')}
              title="Copy"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={exportVisibleLogs}
              disabled={visibleTaskLogs.length === 0}
              className={[
                'p-1.5 border border-border transition-colors touch-manipulation',
                visibleTaskLogs.length === 0 ? 'opacity-40 cursor-not-allowed text-[#444]' : 'text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10',
              ].join(' ')}
              title="Export"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowLogs(false)}
              className="p-1.5 border border-border text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation"
              title="Collapse"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="px-3 py-2 border-b border-border bg-[#0a0a0a]">
          <div className="text-[9px] uppercase font-bold flex items-center">
            {taskStatus === 'success' && <span className="text-primary flex items-center"><CheckCircle2 className="w-2.5 h-2.5 mr-1" /> SUCCESS</span>}
            {taskStatus === 'failed' && <span className="text-red-500 flex items-center"><XCircle className="w-2.5 h-2.5 mr-1" /> FAILED</span>}
            {taskStatus === 'running' && <span className="text-blue-400 flex items-center"><Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" /> RUNNING</span>}
            {taskStatus === 'idle' && <span className="text-[#444] flex items-center"><Terminal className="w-2.5 h-2.5 mr-1" /> IDLE</span>}
          </div>
          <div className="mt-1 text-[8px] text-[#444] font-mono truncate">
            {activeTaskId ? `TASK: ${activeTaskId}` : 'TASK: NONE'}
          </div>
        </div>

        <div className="px-3 py-2 border-b border-border bg-[#0a0a0a] space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              className="flex-1 bg-black border border-border px-2 py-1.5 text-[10px] text-textMain focus:border-primary outline-none transition-colors"
              placeholder="搜索日志"
            />
            <select
              value={logCategory}
              onChange={(e) => setLogCategory(e.target.value as 'all' | 'target' | 'system')}
              className="bg-black border border-border px-2 py-1.5 text-[10px] text-textMain focus:border-primary outline-none transition-colors"
            >
              <option value="all">ALL</option>
              <option value="target">TARGET</option>
              <option value="system">SYSTEM</option>
            </select>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {(['DEBUG', 'INFO', 'WARN', 'ERROR'] as const).map((lvl) => (
              <button
                key={lvl}
                onClick={() => toggleLogLevel(lvl)}
                className={[
                  'px-2 py-1 border border-border text-[9px] uppercase font-bold transition-colors touch-manipulation',
                  logLevelEnabled[lvl] ? 'text-primary bg-primary/10' : 'text-[#444] hover:text-primary hover:bg-primary/10 active:bg-primary/10',
                ].join(' ')}
              >
                {lvl}
              </button>
            ))}
            {unseenLogCount > 0 && (
              <button
                onClick={() => scrollLogsToBottom('smooth')}
                className="ml-auto px-2 py-1 border border-primary/40 text-[9px] uppercase font-bold text-primary bg-primary/10 hover:bg-primary/20 active:bg-primary/20 transition-colors touch-manipulation"
              >
                NEW ({unseenLogCount})
              </button>
            )}
          </div>
        </div>

        {Object.keys(targetStates).length > 0 && (
          <div className="px-3 py-2 border-b border-border bg-[#0a0a0a]">
            <div className="text-[9px] uppercase font-bold text-[#444]">Targets</div>
            <div className="mt-2 space-y-2">
              {Object.values(targetStates)
                .slice()
                .sort((a, b) => a.targetRef.localeCompare(b.targetRef))
                .map((t) => {
                  const p = Number.isFinite(t.progress) ? Math.min(1, Math.max(0, t.progress)) : 0;
                  const pct = Math.round(p * 100);
                  const statusColor =
                    t.status === 'success' ? 'text-primary' :
                    t.status === 'failed' ? 'text-red-500' :
                    t.status === 'canceled' ? 'text-yellow-500' :
                    t.status === 'running' ? 'text-blue-400' : 'text-[#666]';
                  return (
                    <div key={t.targetRef} className="border border-border bg-black/40 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[9px] text-textMain font-mono truncate">{t.targetRef}</div>
                        <div className={`text-[9px] uppercase font-bold ${statusColor}`}>
                          {t.status}{t.attempts > 0 ? ` (${t.attempts})` : ''}
                        </div>
                      </div>
                      <div className="mt-1 h-1.5 bg-[#111] border border-border">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      {t.error && (
                        <div className="mt-1 text-[8px] text-red-500 break-all">{t.error}</div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        <div
          ref={logScrollRef}
          onScroll={onLogScroll}
          className="flex-1 overflow-y-auto p-3 font-mono text-[10px] space-y-1 bg-black/40"
        >
          {visibleTaskLogs.length === 0 ? (
            <div className="text-[#333] italic">Waiting for logs...</div>
          ) : (
            visibleTaskLogs.map((log, i) => (
              <div
                key={`${log}-${i}`}
                className="flex space-x-2 cursor-default"
                onDoubleClick={() => locateNodeFromLog(log)}
                title="双击尝试定位节点"
              >
                <span className="text-textMain leading-relaxed break-all whitespace-pre-wrap">{log}</span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>

      {!showLogs && (
        <button
          onClick={() => setShowLogs(true)}
          className="hidden md:flex items-center justify-center w-8 border-l border-border bg-[#0d0d0d] text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation"
          title="Expand Logs"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}

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
              <div className="border border-border bg-black/40 p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[9px] uppercase font-bold text-[#444] tracking-wider">Current Pipeline</div>
                  <button
                    onClick={() => setIsPipeMetaEditing((v) => !v)}
                    className="px-2 py-1 border border-border text-[8px] uppercase font-bold transition-colors touch-manipulation text-[#666] hover:text-primary hover:bg-primary/10 active:bg-primary/10"
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
                    className="w-full bg-black border border-border p-2 text-[10px] text-textMain font-bold focus:border-primary outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed disabled:text-[#444]"
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
                    className="w-full bg-black border border-border p-2 text-[10px] text-textMain focus:border-primary outline-none transition-colors resize-y disabled:opacity-60 disabled:cursor-not-allowed disabled:text-[#444]"
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
                      title={!isSaving && !isDirty && !isAutoSaving ? '已自动保存' : '保存'}
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

              <div className="border border-border bg-black/40 p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[9px] uppercase font-bold text-[#444] tracking-wider">Pipeline List</div>
                  <input
                    type="text"
                    value={pipeSearch}
                    onChange={(e) => setPipeSearch(e.target.value)}
                    className="w-[220px] bg-black border border-border p-2 text-[10px] text-textMain focus:border-primary outline-none transition-colors"
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
                      <div key={p.id} className="border border-border bg-black/40 p-2 flex items-center justify-between gap-2">
                        <button
                          onClick={() => selectPipe(p.id)}
                          className="flex-1 text-left"
                          title={p.id}
                        >
                          <div className="text-[10px] text-textMain font-bold truncate">
                            {p.name}{p.id === pipeId ? ' (active)' : ''}
                          </div>
                          <div className="text-[8px] text-[#444] font-mono truncate">
                            {p.id} · v{p.version} · {p.updated_at}
                          </div>
                        </button>
                        <button
                          onClick={() => deletePipeById(p.id)}
                          className="p-1.5 border border-red-900/50 text-red-500 hover:bg-red-500/10 active:bg-red-500/10 transition-colors touch-manipulation"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-border bg-[#111] flex justify-end">
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
                <label className="text-[9px] uppercase font-bold text-[#444] tracking-wider">Pipeline Name</label>
                <input
                  ref={createPipeNameInputRef}
                  type="text"
                  value={pipeDraftName}
                  onChange={(e) => setPipeDraftName(e.target.value)}
                  className="w-full bg-black border border-border p-2 text-[10px] text-textMain font-bold focus:border-primary outline-none transition-colors"
                  placeholder="Enter pipeline name"
                />
                {createPipeError && (
                  <div className="text-[9px] text-red-500">{createPipeError}</div>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-[9px] uppercase font-bold text-[#444] tracking-wider">Pipeline Description</label>
                <textarea
                  value={pipeDraftDescription}
                  onChange={(e) => setPipeDraftDescription(e.target.value)}
                  rows={3}
                  className="w-full bg-black border border-border p-2 text-[10px] text-textMain focus:border-primary outline-none transition-colors resize-y"
                  placeholder="Enter pipeline description (optional)"
                />
              </div>
            </div>

            <div className="p-4 border-t border-border bg-[#111] flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  className="btn-secondary !py-2 !px-4 touch-manipulation"
                >
                  CANCEL
                </button>
              </Dialog.Close>
              <button
                onClick={createPipe}
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
                <div className="text-[10px] text-[#444]">No versions</div>
              ) : (
                pipeVersions.map((v) => (
                  <div key={v.version} className="border border-border bg-black/40 p-2 flex items-center justify-between gap-2">
                    <div className="flex-1">
                      <div className="text-[10px] text-textMain font-bold">v{v.version}</div>
                      <div className="text-[8px] text-[#444] font-mono truncate">{v.updated_at}</div>
                    </div>
                    <button
                      onClick={() => loadVersion(v.version)}
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
                <div className="text-[10px] text-[#444]">No ops</div>
              ) : (
                pipeOps.map((op, idx) => (
                  <div key={`${op.ts}-${idx}`} className="border border-border bg-black/40 p-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[9px] text-textMain font-mono truncate">{op.kind}</div>
                      <div className="text-[8px] text-[#444] font-mono">{op.ts}</div>
                    </div>
                    {op.data != null && (
                      <div className="mt-1 text-[9px] text-[#666] font-mono break-all whitespace-pre-wrap">
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
                <div className="text-[10px] text-[#444]">No logs</div>
              ) : (
                autoSaveLogs.map((line, idx) => (
                  <div key={`${line}-${idx}`} className="border border-border bg-black/40 p-2">
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
        onOpenChange={setIsConflictDialogOpen}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={modalOverlayClassName} />
          <Dialog.Content
            className={[
              modalShellClassName,
              'max-w-[560px]',
            ].join(' ')}
          >
            <div className={modalHeaderClassName}>
              <div className="flex items-center space-x-2">
                <XCircle className="w-4 h-4 text-red-500" />
                <Dialog.Title className={modalIconTitleClassName}>保存冲突</Dialog.Title>
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

            <div className="p-4 space-y-3">
              <div className="text-[10px] text-textMain">
                检测到其他会话已更新该 Pipeline，本次自动保存未写入。
              </div>
              <div className="border border-border bg-black/40 p-3 space-y-1">
                <div className="flex justify-between text-[9px]">
                  <span className="text-[#444]">SERVER_VERSION:</span>
                  <span className="text-textMain font-mono">{conflictServerMeta?.version ?? '-'}</span>
                </div>
                <div className="flex justify-between text-[9px]">
                  <span className="text-[#444]">SERVER_UPDATED_AT:</span>
                  <span className="text-textMain font-mono">{conflictServerMeta?.updated_at ?? '-'}</span>
                </div>
                <div className="flex justify-between text-[9px]">
                  <span className="text-[#444]">LOCAL_BASE_UPDATED_AT:</span>
                  <span className="text-textMain font-mono">{pipeUpdatedAt ?? '-'}</span>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={reloadPipeFromServer}
                  disabled={!pipeId || isAutoSaving || isPipeLoading}
                  className={[
                    'btn-secondary !py-2 !px-4 touch-manipulation',
                    !pipeId || isAutoSaving || isPipeLoading ? 'opacity-40 cursor-not-allowed' : '',
                  ].join(' ')}
                >
                  拉取最新
                </button>
                <button
                  onClick={forceOverwritePipe}
                  disabled={!pipeId || isAutoSaving || isPipeLoading}
                  className={[
                    'btn-primary !py-2 !px-4 touch-manipulation',
                    !pipeId || isAutoSaving || isPipeLoading ? 'opacity-40 cursor-not-allowed' : '',
                  ].join(' ')}
                >
                  强制覆盖
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={isNodeDialogOpen}
        onOpenChange={(open) => {
          setIsNodeDialogOpen(open);
          if (!open) {
            setSelectedNode(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={modalOverlayClassName} />
          <Dialog.Content
            className={[
              modalShellClassName,
              'max-w-[720px]',
            ].join(' ')}
          >
            <div className={modalHeaderClassName}>
              <div className="flex items-center space-x-2">
                <Settings2 className="w-4 h-4 text-primary" />
                <Dialog.Title className={modalIconTitleClassName}>Node_Configure</Dialog.Title>
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

            <div className="p-4 space-y-5 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[9px] text-[#444] uppercase font-bold tracking-wider">Node_ID</label>
                  <div className="bg-black border border-border p-2 text-[10px] text-[#666] font-mono">
                    {selectedNode?.id ?? ''}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[9px] text-[#444] uppercase font-bold tracking-wider">Node_Type</label>
                  <div className="bg-black border border-border p-2 text-[10px] text-[#666] font-mono">
                    {selectedNode?.type ?? ''}
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[9px] text-[#444] uppercase font-bold tracking-wider">Display_Name</label>
                <input
                  type="text"
                  value={nodeDraft.label}
                  onChange={(e) => setNodeDraft((prev) => ({ ...prev, label: e.target.value }))}
                  className="w-full bg-black border border-border p-2 text-[10px] text-textMain font-bold focus:border-primary outline-none transition-colors"
                />
              </div>

              {selectedNode?.type === 'targetNode' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[9px] text-[#444] uppercase font-bold tracking-wider">Image_Reference</label>
                    <div className="relative">
                      {/* 这里使用绝对定位图标 + 输入框左侧留白。
                          由于全局 `input, select` 有 `padding` 的 `!important` 规则（见 `src/index.css`），
                          必须用 Tailwind 的 `!pl-*` 覆盖左侧 padding，避免图标与文字重叠。
                          同时用 `top-1/2` 居中，保证不同字体/浏览器下对齐一致。 */}
                      <Database className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#444]" />
                      <input
                        type="text"
                        placeholder="e.g. nginx:latest"
                        value={nodeDraft.image}
                        onChange={(e) => setNodeDraft((prev) => ({ ...prev, image: e.target.value }))}
                        data-testid="node-image-input"
                        className="w-full bg-black border border-border !pl-9 pr-2 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[9px] text-[#444] uppercase font-bold tracking-wider">Registry_Auth</label>
                    <div className="relative">
                      <Key className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#444]" />
                      <select
                        value={nodeDraft.credId || ''}
                        onChange={(e) => setNodeDraft((prev) => ({ ...prev, credId: e.target.value }))}
                        data-testid="node-cred-select"
                        className="w-full bg-black border border-border !pl-9 pr-2 text-[10px] text-textMain font-bold focus:border-primary outline-none transition-colors appearance-none cursor-pointer"
                      >
                        <option value="">NO_AUTHENTICATION</option>
                        {credentials.map((cred) => (
                          <option key={cred.id} value={cred.id}>{cred.name} ({cred.registry})</option>
                        ))}
                      </select>
                    </div>
                    <p className="text-[8px] text-dim italic mt-1">Select from Vault to enable private sync</p>
                  </div>
                </div>
              )}

              {selectedNode?.type === 'sourceNode' && (
                <div className="space-y-3" data-testid="source-config-wizard">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div
                        className={[
                          'px-2 py-1 border text-[9px] uppercase font-bold tracking-wider',
                          sourceConfigStep === 1 ? 'border-primary text-primary bg-primary/10' : 'border-border text-[#666] bg-black/40',
                        ].join(' ')}
                        data-testid="source-step-indicator-1"
                      >
                        1 Auth
                      </div>
                      <div
                        className={[
                          'px-2 py-1 border text-[9px] uppercase font-bold tracking-wider',
                          sourceConfigStep === 2 ? 'border-primary text-primary bg-primary/10' : 'border-border text-[#666] bg-black/40',
                        ].join(' ')}
                        data-testid="source-step-indicator-2"
                      >
                        2 Load
                      </div>
                      <div
                        className={[
                          'px-2 py-1 border text-[9px] uppercase font-bold tracking-wider',
                          sourceConfigStep === 3 ? 'border-primary text-primary bg-primary/10' : 'border-border text-[#666] bg-black/40',
                        ].join(' ')}
                        data-testid="source-step-indicator-3"
                      >
                        3 Repo
                      </div>
                      <div
                        className={[
                          'px-2 py-1 border text-[9px] uppercase font-bold tracking-wider',
                          sourceConfigStep === 4 ? 'border-primary text-primary bg-primary/10' : 'border-border text-[#666] bg-black/40',
                        ].join(' ')}
                        data-testid="source-step-indicator-4"
                      >
                        4 Tag
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {sourceConfigStep > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            if (sourceConfigStep === 2) setSourceConfigStep(1);
                            if (sourceConfigStep === 3) setSourceConfigStep(2);
                            if (sourceConfigStep === 4) setSourceConfigStep(3);
                          }}
                          className="btn-secondary !py-1.5 !px-2.5 touch-manipulation"
                          data-testid="source-step-back"
                        >
                          <span className="inline-flex items-center gap-1">
                            <ChevronLeft className="w-3 h-3" />
                            上一步
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div
                    className={[
                      'border border-border bg-black/40 p-3 space-y-2',
                      sourceConfigStep === 1 ? 'border-primary/40' : '',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] font-bold text-textMain">步骤 1：选择 Registry_Auth</div>
                      {nodeDraft.credId ? (
                        <div className="text-[9px] text-primary flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          已选择
                        </div>
                      ) : (
                        <div className="text-[9px] text-[#666] flex items-center gap-1">
                          <XCircle className="w-3 h-3" />
                          未选择
                        </div>
                      )}
                    </div>
                    <div className="relative">
                      <Key className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#444]" />
                      <select
                        value={nodeDraft.credId || ''}
                        onChange={(e) => {
                          const nextId = e.target.value;
                          setNodeDraft((prev) => ({ ...prev, credId: nextId, image: '' }));
                          setSourceSelectedRepo('');
                          setSourceSelectedTag('');
                          setSourceNamespace('');
                          setSourceRepositories([]);
                          setSourceTags([]);
                          setRepoLoadError(null);
                          setTagLoadError(null);
                          setSourceRepoQuery('');
                          setSourceTagQuery('');
                        }}
                        data-testid="node-cred-select"
                        className="w-full bg-black border border-border !pl-9 pr-2 text-[10px] text-textMain font-bold focus:border-primary outline-none transition-colors appearance-none cursor-pointer"
                      >
                        <option value="">NO_AUTHENTICATION</option>
                        {credentials.map((cred) => (
                          <option key={cred.id} value={cred.id}>{cred.name} ({cred.registry})</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (!nodeDraft.credId) return;
                          setSourceConfigStep(2);
                          const host = normalizeRegistryHost(getCredentialRegistry(nodeDraft.credId));
                          if (isDockerHubHost(host)) {
                            setRepoLoadError(null);
                            setIsLoadingRepos(false);
                            setSourceRepositories([]);
                            return;
                          }
                          loadRepositoriesForSource(nodeDraft.credId);
                        }}
                        disabled={!nodeDraft.credId}
                        className={[
                          'btn-primary !py-1.5 !px-3 touch-manipulation',
                          !nodeDraft.credId ? 'opacity-40 cursor-not-allowed' : '',
                        ].join(' ')}
                        data-testid="source-step-1-next"
                      >
                        下一步
                      </button>
                    </div>
                  </div>

                  <div
                    className={[
                      'border border-border bg-black/40 p-3 space-y-2',
                      sourceConfigStep === 2 ? 'border-primary/40' : '',
                      sourceConfigStep < 2 ? 'opacity-40 pointer-events-none' : '',
                    ].join(' ')}
                    data-testid="source-step-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] font-bold text-textMain">步骤 2：加载镜像仓库列表</div>
                      {isLoadingRepos ? (
                        <div className="text-[9px] text-[#666] flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Loading
                        </div>
                      ) : (
                        <div className="text-[9px] text-[#666]">
                          {sourceRepositories.length ? `共 ${sourceRepositories.length} 条` : '暂无数据'}
                        </div>
                      )}
                    </div>
                    {repoLoadError && (
                      <div className="text-[9px] text-red-500 flex items-center justify-between gap-2">
                        <span>{repoLoadError}</span>
                        <button
                          type="button"
                          onClick={() => loadRepositoriesForSource(nodeDraft.credId, sourceNamespace)}
                          className="btn-secondary !py-1.5 !px-2.5 touch-manipulation"
                          data-testid="source-repo-retry"
                        >
                          重试
                        </button>
                      </div>
                    )}
                    {isDockerHubHost(normalizeRegistryHost(getCredentialRegistry(nodeDraft.credId))) && (
                      <div className="space-y-2">
                        <div className="text-[9px] text-[#666]">
                          Docker Hub 需要按 namespace 列出镜像（例如：library、bitnami、your-org）
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={sourceNamespace}
                            onChange={(e) => setSourceNamespace(e.target.value)}
                            placeholder="输入 namespace"
                            className="flex-1 bg-black border border-border p-2 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                            data-testid="source-namespace-input"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const ns = String(sourceNamespace || '').trim();
                              if (!ns) return;
                              loadRepositoriesForSource(nodeDraft.credId, ns);
                            }}
                            disabled={isLoadingRepos || !String(sourceNamespace || '').trim()}
                            className={[
                              'btn-secondary !py-1.5 !px-2.5 touch-manipulation',
                              isLoadingRepos || !String(sourceNamespace || '').trim() ? 'opacity-40 cursor-not-allowed' : '',
                            ].join(' ')}
                            data-testid="source-namespace-query"
                          >
                            查询
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setSourceConfigStep(3)}
                        disabled={
                          isLoadingRepos
                          || (
                            isDockerHubHost(normalizeRegistryHost(getCredentialRegistry(nodeDraft.credId)))
                              ? (!String(sourceNamespace || '').trim())
                              : (sourceRepositories.length === 0 && !(repoLoadError && /不支持|catalog/i.test(repoLoadError)))
                          )
                        }
                        className={[
                          'btn-primary !py-1.5 !px-3 touch-manipulation',
                          isLoadingRepos
                            || (
                              isDockerHubHost(normalizeRegistryHost(getCredentialRegistry(nodeDraft.credId)))
                                ? (!String(sourceNamespace || '').trim())
                                : (sourceRepositories.length === 0 && !(repoLoadError && /不支持|catalog/i.test(repoLoadError)))
                            )
                            ? 'opacity-40 cursor-not-allowed'
                            : '',
                        ].join(' ')}
                        data-testid="source-step-2-next"
                      >
                        下一步
                      </button>
                    </div>
                  </div>

                  <div
                    className={[
                      'border border-border bg-black/40 p-3 space-y-2',
                      sourceConfigStep === 3 ? 'border-primary/40' : '',
                      sourceConfigStep < 3 ? 'opacity-40 pointer-events-none' : '',
                    ].join(' ')}
                    data-testid="source-step-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] font-bold text-textMain">步骤 3：选择镜像</div>
                      {sourceSelectedRepo ? (
                        <div className="text-[9px] text-primary font-mono truncate max-w-[240px]" title={sourceSelectedRepo}>
                          {sourceSelectedRepo}
                        </div>
                      ) : (
                        <div className="text-[9px] text-[#666]">未选择</div>
                      )}
                    </div>
                    <input
                      type="text"
                      value={sourceRepoQuery}
                      onChange={(e) => setSourceRepoQuery(e.target.value)}
                      placeholder="搜索镜像仓库..."
                      className="w-full bg-black border border-border p-2 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                      data-testid="source-repo-search"
                    />
                    {sourceRepositories.length === 0 && (
                      <div className="space-y-2">
                        <div className="text-[9px] text-[#666]">
                          请输入镜像仓库（namespace/repo）
                        </div>
                        <input
                          type="text"
                          value={sourceSelectedRepo}
                          onChange={(e) => setSourceSelectedRepo(e.target.value)}
                          placeholder="e.g. library/nginx"
                          className="w-full bg-black border border-border p-2 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                          data-testid="source-repo-manual"
                        />
                        <div className="flex items-center justify-end">
                          <button
                            type="button"
                            onClick={() => {
                              if (!String(sourceSelectedRepo || '').trim()) return;
                              setSourceSelectedTag('');
                              setSourceTags([]);
                              setTagLoadError(null);
                              setSourceTagQuery('');
                              setSourceConfigStep(4);
                            }}
                            disabled={!String(sourceSelectedRepo || '').trim()}
                            className={[
                              'btn-primary !py-1.5 !px-3 touch-manipulation',
                              !String(sourceSelectedRepo || '').trim() ? 'opacity-40 cursor-not-allowed' : '',
                            ].join(' ')}
                          >
                            使用该镜像
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="border border-border bg-black/30 max-h-[200px] overflow-y-auto">
                      {sourceRepositories
                        .filter((r) => {
                          const q = sourceRepoQuery.trim().toLowerCase();
                          if (!q) return true;
                          return String(r || '').toLowerCase().includes(q);
                        })
                        .slice(0, 800)
                        .map((repo) => (
                          <button
                            key={repo}
                            type="button"
                            onClick={() => {
                              setSourceSelectedRepo(repo);
                              setSourceSelectedTag('');
                              setSourceTags([]);
                              setTagLoadError(null);
                              setSourceTagQuery('');
                              setSourceConfigStep(4);
                            }}
                            className={[
                              'w-full text-left px-3 py-2 text-[10px] font-mono border-b border-border hover:bg-primary/10 transition-colors',
                              repo === sourceSelectedRepo ? 'bg-primary/10 text-primary' : 'text-textMain',
                            ].join(' ')}
                            data-testid="source-repo-item"
                          >
                            {repo}
                          </button>
                        ))}
                      {sourceRepositories.length === 0 && (
                        <div className="px-3 py-2 text-[10px] text-[#666]">暂无镜像仓库</div>
                      )}
                    </div>
                  </div>

                  <div
                    className={[
                      'border border-border bg-black/40 p-3 space-y-2',
                      sourceConfigStep === 4 ? 'border-primary/40' : '',
                      sourceConfigStep < 4 ? 'opacity-40 pointer-events-none' : '',
                    ].join(' ')}
                    data-testid="source-step-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] font-bold text-textMain">步骤 4：选择版本标签</div>
                      {isLoadingTags ? (
                        <div className="text-[9px] text-[#666] flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Loading
                        </div>
                      ) : (
                        <div className="text-[9px] text-[#666]">{sourceTags.length ? `共 ${sourceTags.length} 条` : '暂无数据'}</div>
                      )}
                    </div>
                    {tagLoadError && (
                      <div className="text-[9px] text-red-500 flex items-center justify-between gap-2">
                        <span>{tagLoadError}</span>
                        <button
                          type="button"
                          onClick={() => loadTagsForSource(nodeDraft.credId, sourceSelectedRepo)}
                          className="btn-secondary !py-1.5 !px-2.5 touch-manipulation"
                          data-testid="source-tag-retry"
                        >
                          重试
                        </button>
                      </div>
                    )}
                    <input
                      type="text"
                      value={sourceTagQuery}
                      onChange={(e) => setSourceTagQuery(e.target.value)}
                      placeholder="搜索标签..."
                      className="w-full bg-black border border-border p-2 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                      disabled={!sourceSelectedRepo}
                      data-testid="source-tag-search"
                    />
                    <div className="border border-border bg-black/30 max-h-[200px] overflow-y-auto">
                      {sourceTags
                        .filter((t) => {
                          const q = sourceTagQuery.trim().toLowerCase();
                          if (!q) return true;
                          return String(t || '').toLowerCase().includes(q);
                        })
                        .slice(0, 1200)
                        .map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => setSourceSelectedTag(tag)}
                            className={[
                              'w-full text-left px-3 py-2 text-[10px] font-mono border-b border-border hover:bg-primary/10 transition-colors',
                              tag === sourceSelectedTag ? 'bg-primary/10 text-primary' : 'text-textMain',
                            ].join(' ')}
                            data-testid="source-tag-item"
                          >
                            {tag}
                          </button>
                        ))}
                      {!isLoadingTags && sourceSelectedRepo && sourceTags.length === 0 && (
                        <div className="px-3 py-2 text-[10px] text-[#666]">暂无版本标签</div>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[9px] text-[#444] uppercase font-bold tracking-wider">Image_Reference</label>
                      <div className="relative">
                        <Database className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#444]" />
                        <input
                          type="text"
                          value={nodeDraft.image}
                          onChange={(e) => setNodeDraft((prev) => ({ ...prev, image: e.target.value }))}
                          placeholder="请选择 repo 与 tag"
                          data-testid="node-image-input"
                          className="w-full bg-black border border-border !pl-9 pr-2 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {selectedNode?.type === 'processorNode' && (
                <div className="space-y-1.5">
                  <label className="text-[9px] text-[#444] uppercase font-bold tracking-wider">Processor_Type</label>
                  <div className="bg-primary/5 border border-primary/20 p-3 text-primary">
                    <div className="text-[10px] font-bold">MANIFEST_MERGE</div>
                    <div className="text-[8px] mt-1 opacity-70 leading-relaxed">
                      Automatically merge multi-architecture manifests (AMD64, ARM64, etc.) into a single manifest list.
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-[9px] text-[#444] uppercase font-bold tracking-wider">Parameters</label>
                <textarea
                  value={nodeDraft.params}
                  onChange={(e) => setNodeDraft((prev) => ({ ...prev, params: e.target.value }))}
                  placeholder='{"key":"value"}'
                  rows={6}
                  className="w-full bg-black border border-border p-2 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors resize-y"
                />
              </div>
            </div>

            <div className="p-4 border-t border-border bg-[#0a0a0a] flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
              <button
                onClick={removeSelectedNode}
                className="px-3 py-2 border border-red-900/50 text-red-500 text-[9px] uppercase font-bold hover:bg-red-500/10 active:bg-red-500/10 transition-colors touch-manipulation flex items-center justify-center space-x-2"
              >
                <Trash2 className="w-3 h-3" />
                <span>Remove_Node</span>
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={closeNodeDialog}
                  className="btn-secondary !py-2 !px-4 touch-manipulation"
                >
                  CANCEL
                </button>
                <button
                  onClick={saveNodeDraft}
                  className="btn-primary !py-2 !px-4 touch-manipulation"
                >
                  SAVE
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
