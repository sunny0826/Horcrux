import { useState, useCallback, useRef, useEffect } from 'react';
import type { Node, Edge } from 'reactflow';
import api from '../api';
import type { PipeMeta, PipeDTO, PipeVersion, PipeOp } from '../types';
import { computeExponentialBackoffMs, createDebouncedJob } from '../utils/debouncedJob';

export const usePipeline = (nodes: Node[], edges: Edge[], setNodes: (nodes: Node[]) => void, setEdges: (edges: Edge[]) => void) => {
  const [pipes, setPipes] = useState<PipeMeta[]>([]);
  const [pipeId, setPipeId] = useState<string | null>(null);
  const [pipeName, setPipeName] = useState<string>('NEW_PIPE_DESIGN');
  const [pipeDescription, setPipeDescription] = useState<string>('');
  const [pipeVersion, setPipeVersion] = useState<number>(0);
  const [pipeUpdatedAt, setPipeUpdatedAt] = useState<string | null>(null);
  
  const [isDirty, setIsDirty] = useState(false);
  const [isPipeLoading, setIsPipeLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isAutoSaving, setIsAutoSaving] = useState(false);
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<string | null>(null);
  const [autoSaveError, setAutoSaveError] = useState<string | null>(null);
  const [autoSaveLogs, setAutoSaveLogs] = useState<string[]>([]);
  const [conflictServerMeta, setConflictServerMeta] = useState<{ updated_at?: string; version?: number } | null>(null);
  
  const [pipeVersions, setPipeVersions] = useState<PipeVersion[]>([]);
  const [pipeOps, setPipeOps] = useState<PipeOp[]>([]);
  
  const dirtyTokenRef = useRef(0);
  const autoSaveJobRef = useRef<ReturnType<typeof createDebouncedJob> | null>(null);
  const autoSaveRetryJobRef = useRef<ReturnType<typeof createDebouncedJob> | null>(null);
  const autoSaveRetryAttemptRef = useRef(0);
  const flushAutoSaveNowRef = useRef<(() => Promise<void>) | null>(null);
  const opsBufferRef = useRef<PipeOp[]>([]);

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
        setAutoSaveError('Conflict detected');
        appendAutoSaveLog('autosave:conflict');
        return;
      }
      console.error('Auto save failed:', e);
      setAutoSaveError('Auto save failed, retrying...');
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
  }, [appendAutoSaveLog, edges, isDirty, isSaving, nodes, pipeDescription, pipeId, pipeName, pipeUpdatedAt]);

  useEffect(() => {
    flushAutoSaveNowRef.current = flushAutoSaveNow;
  }, [flushAutoSaveNow]);

  useEffect(() => {
    return () => {
      autoSaveJobRef.current?.cancel();
      autoSaveRetryJobRef.current?.cancel();
    };
  }, []);

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
    setAutoSaveError(null);
    setConflictServerMeta(null);
    localStorage.removeItem('horcrux_active_pipe_id');
  }, [setEdges, setNodes]);

  const savePipe = useCallback(async () => {
    const nextName = pipeName.trim();
    if (!nextName) {
      alert('ERROR: Pipeline name cannot be empty');
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
      alert('SUCCESS: Pipeline saved successfully');
    } catch (error) {
      console.error('Failed to save pipe:', error);
      alert('ERROR: Failed to save pipeline');
    } finally {
      setIsSaving(false);
    }
  }, [applyLoadedPipe, edges, flushPipeOpsNow, nodes, pipeDescription, pipeId, pipeName, refreshPipes]);

  const createPipe = useCallback(async (name: string, description: string) => {
    try {
      const res = await api.post('/pipes', { name, description, nodes: [], edges: [] });
      applyLoadedPipe(res.data as PipeDTO);
      await refreshPipes();
      return true;
    } catch (e) {
      console.error('Failed to create pipe:', e);
      return false;
    }
  }, [applyLoadedPipe, refreshPipes]);

  const deletePipeById = useCallback(async (id: string) => {
    if (!id) return;
    if (!window.confirm('Are you sure you want to delete this Pipeline? This action cannot be undone.')) return;
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
      alert('ERROR: Failed to delete pipeline');
    }
  }, [loadPipeById, pipeId, refreshPipes, resetToNewPipe]);

  const loadVersions = useCallback(async () => {
    if (!pipeId) return;
    try {
      const res = await api.get(`/pipes/${pipeId}/versions`);
      const list = Array.isArray(res.data) ? (res.data as PipeVersion[]) : [];
      setPipeVersions(list);
    } catch (e) {
      console.error('Failed to load versions:', e);
      alert('ERROR: Failed to fetch versions');
    }
  }, [pipeId]);

  const loadVersion = useCallback(async (version: number) => {
    if (!pipeId) return;
    try {
      const res = await api.get(`/pipes/${pipeId}/versions/${version}`);
      applyLoadedPipe(res.data as PipeDTO);
      alert(`SUCCESS: Version v${version} loaded`);
      return true;
    } catch (e) {
      console.error('Failed to load version:', e);
      alert('ERROR: Failed to load version');
      return false;
    }
  }, [applyLoadedPipe, pipeId]);

  const loadOps = useCallback(async () => {
    if (!pipeId) return;
    try {
      const res = await api.get(`/pipes/${pipeId}/ops`, { params: { limit: 200 } });
      const list = Array.isArray(res.data) ? (res.data as PipeOp[]) : [];
      setPipeOps(list);
    } catch (e) {
      console.error('Failed to load ops:', e);
      alert('ERROR: Failed to fetch ops');
    }
  }, [pipeId]);

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
      autoSaveRetryAttemptRef.current = 0;
      if (dirtyTokenRef.current === tokenAtStart) {
        setIsDirty(false);
      }
      appendAutoSaveLog('conflict:force_overwrite:success');
      return true;
    } catch (e) {
      console.error('Force overwrite failed:', e);
      setAutoSaveError('Force overwrite failed');
      appendAutoSaveLog('conflict:force_overwrite:error');
      return false;
    } finally {
      setIsAutoSaving(false);
    }
  }, [appendAutoSaveLog, edges, flushPipeOpsNow, isAutoSaving, isSaving, nodes, pipeDescription, pipeId, pipeName, pipeUpdatedAt]);

  const reloadPipeFromServer = useCallback(async () => {
    if (!pipeId) return;
    appendAutoSaveLog('conflict:reload');
    await loadPipeById(pipeId);
    setConflictServerMeta(null);
    setAutoSaveError(null);
  }, [appendAutoSaveLog, loadPipeById, pipeId]);

  const clearAutoSaveLogs = useCallback(() => {
    setAutoSaveLogs([]);
  }, []);

  return {
    pipes,
    pipeId,
    pipeName,
    setPipeName,
    pipeDescription,
    setPipeDescription,
    pipeVersion,
    pipeUpdatedAt,
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
  };
};
