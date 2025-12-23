import { useState, useEffect, useRef } from 'react';
import type { PipeMeta, PipeDTO } from '../types';
import api from '../api';

const parsePipesPage = (data: unknown) => {
  if (Array.isArray(data)) {
    const items = data as PipeMeta[];
    return { items, total: items.length };
  }
  const items = Array.isArray((data as { items?: unknown }).items) ? ((data as { items: PipeMeta[] }).items) : [];
  const totalRaw = (data as { total?: unknown }).total;
  const total = typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? totalRaw : items.length;
  return { items, total };
};

export function usePipes(activeTab: string) {
  const [pipes, setPipes] = useState<PipeMeta[]>([]);
  const [isPipesLoading, setIsPipesLoading] = useState(false);
  const [isPipesLoadingMore, setIsPipesLoadingMore] = useState(false);
  const [pipesError, setPipesError] = useState<string | null>(null);
  const [pipesTotal, setPipesTotal] = useState(0);
  const [activePipeIndex, setActivePipeIndex] = useState(0);
  const [activePipeDetail, setActivePipeDetail] = useState<PipeDTO | null>(null);
  const [isPipeDetailLoading, setIsPipeDetailLoading] = useState(false);
  const [isPipePreviewVisible, setIsPipePreviewVisible] = useState(true);
  
  const pipesRef = useRef<PipeMeta[]>([]);
  const pipeListScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    pipesRef.current = pipes;
  }, [pipes]);

  useEffect(() => {
    if (activeTab !== 'dashboard') return;
    let isCancelled = false;

    const pageSize = 50;
    const fetchPipesPage = async (offset: number) => {
      const res = await api.get('/pipes', {
        params: { meta_only: 1, with_total: 1, limit: pageSize, offset },
      });
      return parsePipesPage(res.data as unknown);
    };

    const loadPipes = async () => {
      setIsPipesLoading(true);
      setPipesError(null);
      try {
        if (isCancelled) return;
        const { items, total } = await fetchPipesPage(0);
        if (isCancelled) return;
        const list = Array.isArray(items) ? items : [];
        setPipes(list);
        setPipesTotal(total);

        const storedPipeId = localStorage.getItem('horcrux_active_pipe_id');
        const preferredIndex =
          storedPipeId ? Math.max(0, list.findIndex((p) => p.id === storedPipeId)) : 0;
        setActivePipeIndex((prev) => {
          if (list.length === 0) return 0;
          if (prev >= 0 && prev < list.length) return prev;
          return preferredIndex >= 0 ? preferredIndex : 0;
        });
      } catch (e) {
        if (isCancelled) return;
        setPipes([]);
        setPipesError(e instanceof Error ? e.message : 'Failed to load pipelines');
        setPipesTotal(0);
      } finally {
        if (!isCancelled) setIsPipesLoading(false);
      }
    };

    loadPipes();
    const interval = setInterval(async () => {
      if (isCancelled) return;
      if (pipesRef.current.length === 0) {
        await loadPipes();
        return;
      }
      try {
        const { items, total } = await fetchPipesPage(0);
        if (isCancelled) return;
        const updates = new Map(items.map((p) => [p.id, p]));
        setPipes((prev) => prev.map((p) => updates.get(p.id) ?? p));
        setPipesTotal(total);
      } catch {
        // ignore
      }
    }, 30000);
    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [activeTab]);

  const loadMorePipes = async () => {
    if (isPipesLoading) return;
    if (isPipesLoadingMore) return;
    if (pipesTotal > 0 && pipes.length >= pipesTotal) return;
    setIsPipesLoadingMore(true);
    try {
      const { items, total } = await (async () => {
        const pageSize = 50;
        const res = await api.get('/pipes', {
          params: { meta_only: 1, with_total: 1, limit: pageSize, offset: pipes.length },
        });
        return parsePipesPage(res.data as unknown);
      })();
      const list = Array.isArray(items) ? items : [];
      const seen = new Set(pipes.map((p) => p.id));
      const next = list.filter((p) => !seen.has(p.id));
      setPipes((prev) => prev.concat(next));
      setPipesTotal(total);
    } catch {
      // ignore
    } finally {
      setIsPipesLoadingMore(false);
    }
  };

  const onPipeListScroll = () => {
    const el = pipeListScrollRef.current;
    if (!el) return;
    const threshold = 80;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    if (!nearBottom) return;
    loadMorePipes();
  };

  useEffect(() => {
    if (activeTab !== 'dashboard') return;
    if (!pipes[activePipeIndex]?.id) return;
    let isCancelled = false;

    const loadDetail = async () => {
      const id = pipes[activePipeIndex]?.id;
      if (!id) return;
      setIsPipeDetailLoading(true);
      try {
        const res = await api.get(`/pipes/${encodeURIComponent(id)}`);
        const data = res.data as PipeDTO;
        if (isCancelled) return;
        setActivePipeDetail(data);
      } catch {
        if (isCancelled) return;
        setActivePipeDetail(null);
      } finally {
        if (!isCancelled) setIsPipeDetailLoading(false);
      }
    };

    loadDetail();
    return () => {
      isCancelled = true;
    };
  }, [activePipeIndex, activeTab, pipes]);

  useEffect(() => {
    if (activeTab !== 'dashboard') return;
    if (pipes.length <= 1) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTyping =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        Boolean(target?.isContentEditable);
      if (isTyping) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setActivePipeIndex((prev) => (prev - 1 + pipes.length) % pipes.length);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setActivePipeIndex((prev) => (prev + 1) % pipes.length);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTab, pipes.length]);

  useEffect(() => {
    if (activeTab !== 'dashboard') return;
    setIsPipePreviewVisible(false);
    const t = window.setTimeout(() => setIsPipePreviewVisible(true), 30);
    return () => window.clearTimeout(t);
  }, [activePipeIndex, activeTab]);

  return {
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
    loadMorePipes,
    onPipeListScroll,
    pipeListScrollRef
  };
}
