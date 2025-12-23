import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Terminal, X, Play, Trash2, Copy, Download, ChevronRight, CheckCircle2, XCircle, Loader2, ChevronLeft } from 'lucide-react';
import type { TargetRuntimeState } from '../types';

interface LogPanelProps {
  taskLogs: string[];
  taskStatus: string;
  activeTaskId: string | null;
  taskCancelRequested: boolean;
  targetStates: Record<string, TargetRuntimeState>;
  showLogs: boolean;
  setShowLogs: (show: boolean) => void;
  onClearLogs: () => void;
  didClearLogs: boolean;
  onCancelTask: () => void;
  onRetryFailedTargets: () => void;
  onLocateNode: (log: string) => void;
  isMdUp: boolean;
  variant?: 'drawer' | 'card';
}

export const LogPanel: React.FC<LogPanelProps> = ({
  taskLogs,
  taskStatus,
  activeTaskId,
  taskCancelRequested,
  targetStates,
  showLogs,
  setShowLogs,
  onClearLogs,
  didClearLogs,
  onCancelTask,
  onRetryFailedTargets,
  onLocateNode,
  isMdUp,
  variant = 'drawer',
}) => {
  const isCard = variant === 'card';
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

  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const lastTaskLogCountRef = useRef(0);
  const logResizeStartRef = useRef<{ x: number; width: number } | null>(null);

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
    setLogVisibleCount(400);
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
      alert('Copy failed: Browser not supported or permission denied');
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

  useEffect(() => {
    if (!showLogs) return;
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [showLogs, taskLogs.length]);

  return (
    <>
      <div
        ref={isCard ? logScrollRef : undefined}
        onScroll={isCard ? onLogScroll : undefined}
        className={[
          isCard 
            ? 'w-full h-full flex flex-col overflow-y-auto overflow-x-hidden scrollbar-custom bg-background' 
            : 'border-l border-border bg-background flex flex-col overflow-hidden transition-all duration-200 relative',
          !isCard && 'w-full md:w-auto',
          !isCard && (showLogs ? 'max-h-[40vh] md:max-h-none' : 'max-h-0 md:w-0'),
        ].filter(Boolean).join(' ')}
        style={!isCard && isMdUp ? { width: showLogs ? logPanelWidth : 0 } : undefined}
      >
        {!isCard && showLogs && isMdUp && (
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
        <div
          className={[
            'p-3 border-b border-border flex items-center justify-between',
            isCard ? 'sticky top-0 z-20 bg-background' : 'bg-panel',
          ].join(' ')}
        >
          <div className="flex items-center space-x-2">
            <Terminal className="w-3.5 h-3.5 text-primary" />
            <span className="text-[10px] font-bold text-primary uppercase tracking-widest">Live_Task_Log</span>
            {taskStatus === 'running' && <span className="flex h-1.5 w-1.5 rounded-full bg-primary animate-pulse"></span>}
          </div>
          <div className="flex items-center space-x-2">
            {activeTaskId && taskStatus === 'running' && (
              <button
                onClick={onCancelTask}
                disabled={taskCancelRequested}
                className={[
                  'px-2 py-1 border border-border text-[9px] uppercase font-bold transition-colors touch-manipulation flex items-center space-x-1',
                  taskCancelRequested ? 'opacity-60 cursor-not-allowed text-textMain/60' : 'text-textMain/60 hover:text-red-400 hover:bg-red-500/10 active:bg-red-500/10',
                ].join(' ')}
                title="Cancel"
              >
                <X className="w-3 h-3" />
                <span>{taskCancelRequested ? 'CANCELING...' : 'CANCEL'}</span>
              </button>
            )}
            {activeTaskId && taskStatus !== 'running' && taskStatus !== 'idle' && (
              <button
                onClick={onRetryFailedTargets}
                className="px-2 py-1 border border-border text-[9px] uppercase font-bold transition-colors touch-manipulation flex items-center space-x-1 text-textMain/60 hover:text-primary hover:bg-primary/10 active:bg-primary/10"
                title="Retry Failed"
              >
                <Play className="w-3 h-3" />
                <span>RETRY_FAILED</span>
              </button>
            )}
            <button
              onClick={onClearLogs}
              disabled={taskLogs.length === 0}
              className={[
                'px-2 py-1 border border-border text-[9px] uppercase font-bold transition-colors touch-manipulation flex items-center space-x-1',
                taskLogs.length === 0 ? 'opacity-40 cursor-not-allowed text-textMain/40' : 'text-textMain/60 hover:text-primary hover:bg-primary/10 active:bg-primary/10',
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
                visibleTaskLogs.length === 0 ? 'opacity-40 cursor-not-allowed text-textMain/40' : 'text-textMain/60 hover:text-primary hover:bg-primary/10 active:bg-primary/10',
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
                visibleTaskLogs.length === 0 ? 'opacity-40 cursor-not-allowed text-textMain/40' : 'text-textMain/60 hover:text-primary hover:bg-primary/10 active:bg-primary/10',
              ].join(' ')}
              title="Export"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            {!isCard && (
              <button
                onClick={() => setShowLogs(false)}
                className="p-1.5 border border-border text-textMain/60 hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation"
                title="Collapse"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className={`px-3 py-2 border-b border-border ${isCard ? 'bg-background' : 'bg-background'}`}>
          <div className="text-[9px] uppercase font-bold flex items-center">
            {taskStatus === 'success' && <span className="text-primary flex items-center"><CheckCircle2 className="w-2.5 h-2.5 mr-1" /> SUCCESS</span>}
            {taskStatus === 'failed' && <span className="text-red-500 flex items-center"><XCircle className="w-2.5 h-2.5 mr-1" /> FAILED</span>}
            {taskStatus === 'running' && <span className="text-blue-400 flex items-center"><Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" /> RUNNING</span>}
            {taskStatus === 'idle' && <span className="text-textMain/40 flex items-center"><Terminal className="w-2.5 h-2.5 mr-1" /> IDLE</span>}
          </div>
          <div className="mt-1 text-[8px] text-textMain/40 font-mono truncate">
            {activeTaskId ? `TASK: ${activeTaskId}` : 'TASK: NONE'}
          </div>
        </div>

        <div className={`px-3 py-2 border-b border-border space-y-2 ${isCard ? 'bg-background' : 'bg-background'}`}>
          <div className="flex items-center gap-2">
            <input
              value={logSearch}
              onChange={(e) => {
                setLogSearch(e.target.value);
                setLogVisibleCount(400);
              }}
              className="flex-1 bg-panel border border-border px-2 py-1.5 text-[10px] text-textMain focus:border-primary outline-none transition-colors"
              placeholder="Search logs"
            />
            <select
              value={logCategory}
              onChange={(e) => {
                setLogCategory(e.target.value as 'all' | 'target' | 'system');
                setLogVisibleCount(400);
              }}
              className="bg-panel border border-border px-2 py-1.5 text-[10px] text-textMain focus:border-primary outline-none transition-colors"
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
                  logLevelEnabled[lvl] ? 'text-primary bg-primary/10' : 'text-textMain/40 hover:text-primary hover:bg-primary/10 active:bg-primary/10',
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
          <div className={`px-3 py-2 border-b border-border ${isCard ? 'bg-background' : 'bg-background'}`}>
            <div className="text-[9px] uppercase font-bold text-textMain/40">Targets</div>
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
                    t.status === 'running' ? 'text-blue-400' : 'text-textMain/60';
                  return (
                    <div key={t.targetRef} className="border border-border bg-panel/40 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[9px] text-textMain font-mono truncate">{t.targetRef}</div>
                        <div className={`text-[9px] uppercase font-bold ${statusColor}`}>
                          {t.status}{t.attempts > 0 ? ` (${t.attempts})` : ''}
                        </div>
                      </div>
                      <div className="mt-1 h-1.5 bg-panel border border-border">
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
          ref={isCard ? undefined : logScrollRef}
          onScroll={isCard ? undefined : onLogScroll}
          className={[
            isCard ? 'p-3 font-mono text-[10px] space-y-1' : 'flex-1 overflow-y-auto p-3 font-mono text-[10px] space-y-1 scrollbar-custom',
            isCard ? 'bg-background' : 'bg-panel/40',
          ].join(' ')}
        >
          {visibleTaskLogs.length === 0 ? (
            <div className="text-textMain/30 italic">Waiting for logs...</div>
          ) : (
            visibleTaskLogs.map((log, i) => (
              <div
                key={`${log}-${i}`}
                className="flex space-x-2 cursor-default"
                onDoubleClick={() => onLocateNode(log)}
                title="Double click to locate node"
              >
                <span className="text-textMain leading-relaxed break-all whitespace-pre-wrap">{log}</span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>

      {!isCard && !showLogs && (
        <button
          onClick={() => setShowLogs(true)}
          className="hidden md:flex items-center justify-center w-8 border-l border-border bg-background text-textMain/60 hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation"
          title="Expand Logs"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}
    </>
  );
};
