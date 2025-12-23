import { useState, useEffect } from 'react';
import type { TargetRuntimeState, TaskEvent } from '../types';

export function useTaskWebSocket() {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState<string>('idle');
  const [taskLogs, setTaskLogs] = useState<string[]>([]);
  const [targetStates, setTargetStates] = useState<Record<string, TargetRuntimeState>>({});
  const [taskCancelRequested, setTaskCancelRequested] = useState(false);
  const [logs, setLogs] = useState<{time: string, level: string, msg: string}[]>([]);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isTauri = typeof window !== 'undefined' && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = isTauri ? 'ws://127.0.0.1:7626/api/ws' : `${protocol}//${window.location.host}/api/ws`;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('Failed to connect websocket:', e);
      return;
    }

    ws.onopen = () => {
      // setWsStatus('CONNECTED');
    };
    ws.onclose = () => {
      // setWsStatus('DISCONNECTED');
    };
    ws.onerror = () => {
      // setWsStatus('ERROR');
    };
    
    ws.onmessage = (event) => {
      const data = event.data as string;
      const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
      
      // Handle task specific events
      if (activeTaskId) {
        if (data.startsWith(`TASK_LOG:${activeTaskId}:`)) {
          const log = data.replace(`TASK_LOG:${activeTaskId}:`, '');
          setTaskLogs(prev => {
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
        } else if (data.startsWith(`TASK_FAILED:${activeTaskId}:`)) {
          setTaskStatus('failed');
        }
      }

      // Keep system logs as well
      setLogs(prev => [...prev, {
        time: now,
        level: 'SYNC',
        msg: event.data
      }].slice(-100)); // Keep last 100 logs
    };

    return () => ws?.close();
  }, [activeTaskId]);

  return {
    activeTaskId,
    setActiveTaskId,
    taskStatus,
    setTaskStatus,
    taskLogs,
    setTaskLogs,
    targetStates,
    setTargetStates,
    taskCancelRequested,
    setTaskCancelRequested,
    logs,
    setLogs
  };
}
