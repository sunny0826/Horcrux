import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { History, Terminal, CheckCircle2, XCircle, Loader2, Search, ChevronRight, Download, RefreshCw, X } from 'lucide-react';
import api from '../api';

interface SyncTask {
  id: string;
  mode?: string;
  source_ref: string;
  target_ref: string;
  source_id?: string;
  target_id?: string;
  status: string;
  cancel_requested?: boolean;
  error_summary?: string;
  created_at: string;
  ended_at?: string;
  logs?: string[];
}

type StatusFilter = 'all' | 'success' | 'failed' | 'running';

const formatDateTime = (value?: string) => {
  if (!value) return '---';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '---';

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const getDurationText = (createdAt?: string, endedAt?: string) => {
  if (!createdAt || !endedAt) return '---';
  const s = new Date(createdAt).getTime();
  const e = new Date(endedAt).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return '---';
  return `${Math.round((e - s) / 1000)}s`;
};

const getRegistryHost = (ref?: string) => {
  if (!ref) return '---';
  const first = ref.split('/')[0] || '';
  const looksLikeHost = first.includes('.') || first.includes(':') || first === 'localhost';
  return looksLikeHost ? first : 'docker.io';
};

const getImageIdentity = (ref?: string) => {
  if (!ref) return { primary: '---', secondary: '' };

  const withoutScheme = ref.replace(/^https?:\/\//, '');
  const parts = withoutScheme.split('/');
  const first = parts[0] || '';
  const looksLikeHost = first.includes('.') || first.includes(':') || first === 'localhost';
  const path = (looksLikeHost ? parts.slice(1) : parts).join('/');
  const [namePart, digestPart] = path.split('@');
  if (!digestPart) return { primary: namePart || '---', secondary: '' };

  const shortDigest = digestPart.length > 16 ? `${digestPart.slice(0, 12)}...${digestPart.slice(-4)}` : digestPart;
  return { primary: namePart || '---', secondary: `SHA256:${shortDigest}` };
};

const csvEscape = (v: unknown) => {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const downloadTextFile = (filename: string, content: string, mime = 'text/plain') => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const HistoryView: React.FC = () => {
  const [tasks, setTasks] = useState<SyncTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [selectedTask, setSelectedTask] = useState<SyncTask | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [detailOpen, setDetailOpen] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true);
      setNotice(null);
      const res = await api.get('/tasks');
      const data = res.data;
      const tasksData = data?.tasks || (Array.isArray(data) ? data : []);
      setTasks(Array.isArray(tasksData) ? tasksData : []);
      if (Array.isArray(data?.errors) && data.errors.length > 0) {
        setNotice(String(data.errors.slice(0, 3).join('\n')));
      }
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
      setNotice(error instanceof Error ? error.message : 'Failed to fetch tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const fetchTaskDetails = useCallback(async (id: string) => {
    try {
      setLoadingDetails(true);
      const res = await api.get(`/tasks/${id}`);
      const data = res.data;
      if (data && typeof data === 'object' && 'task' in data) {
        const task = (data as { task?: SyncTask }).task;
        setSelectedTask(task ?? null);
        const warnings = (data as { warnings?: unknown }).warnings;
        if (Array.isArray(warnings) && warnings.length > 0) {
          setNotice(String(warnings.slice(0, 3).join('\n')));
        }
      } else {
        setSelectedTask(data as SyncTask);
      }
    } catch (error) {
      console.error('Failed to fetch task details:', error);
      setNotice(error instanceof Error ? error.message : 'Failed to fetch task details');
    } finally {
      setLoadingDetails(false);
    }
  }, []);

  const filteredTasks = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return tasks.filter(task => {
      if (statusFilter !== 'all' && task.status !== statusFilter) return false;
      if (!q) return true;

      const identity = getImageIdentity(task.target_ref || task.source_ref);
      const srcHost = getRegistryHost(task.source_ref);
      const dstHost = getRegistryHost(task.target_ref);

      return (
        (task.source_ref || '').toLowerCase().includes(q) ||
        (task.target_ref || '').toLowerCase().includes(q) ||
        (task.id || '').toLowerCase().includes(q) ||
        identity.primary.toLowerCase().includes(q) ||
        identity.secondary.toLowerCase().includes(q) ||
        `${srcHost} -> ${dstHost}`.toLowerCase().includes(q)
      );
    });
  }, [tasks, searchTerm, statusFilter]);

  const closeTaskDetail = useCallback(() => {
    setDetailOpen(false);
    setSelectedTask(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    if (!detailOpen) return;
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [detailOpen, loadingDetails, selectedTask?.logs?.length]);

  useEffect(() => {
    if (!detailOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTaskDetail();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeTaskDetail, detailOpen]);

  const openTaskDetail = useCallback(async (id: string) => {
    setDetailOpen(true);
    setNotice(null);
    await fetchTaskDetails(id);
  }, [fetchTaskDetails]);

  const handleExportCsv = useCallback(() => {
    const header = ['JOB_ID', 'SOURCE_REF', 'TARGET_REF', 'STATUS', 'CREATED_AT', 'ENDED_AT', 'DURATION'];
    const rows = filteredTasks.map(t => ([
      t.id,
      t.source_ref,
      t.target_ref,
      t.status,
      t.created_at,
      t.ended_at || '',
      getDurationText(t.created_at, t.ended_at),
    ]));

    const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
    downloadTextFile(`sync_history_${Date.now()}.csv`, csv, 'text/csv;charset=utf-8');
  }, [filteredTasks]);

  const handleDownloadLog = useCallback(() => {
    if (!selectedTask?.logs || selectedTask.logs.length === 0) return;
    downloadTextFile(`task_${selectedTask.id}_logs.txt`, selectedTask.logs.join('\n'), 'text/plain;charset=utf-8');
  }, [selectedTask]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success': return <CheckCircle2 className="w-3 h-3 text-primary" />;
      case 'failed': return <XCircle className="w-3 h-3 text-red-500" />;
      case 'running': return <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />;
      default: return <History className="w-3 h-3 text-textMain/40" />;
    }
  };

  const getStatusText = (status: string) => {
    return <span className={`text-[8px] font-bold uppercase ${
      status === 'success' ? 'text-primary' : 
      status === 'failed' ? 'text-red-500' : 
      status === 'running' ? 'text-blue-400' : 'text-textMain/40'
    }`}>{status}</span>;
  };

  return (
    <div className="relative h-full overflow-hidden flex flex-col p-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-primary tracking-widest uppercase flex items-center">
            <History className="w-5 h-5 mr-2" />
            Sync_Execution_Logs
          </h2>
          <p className="text-[10px] text-textMain/40 mt-1 font-mono">
            {loading ? '> QUERYING_DATABASE...' : `> QUERYING_DATABASE... [MATCH_FOUND: ${filteredTasks.length}_RECORDS]`}
          </p>
          {notice && (
            <pre className="mt-2 text-[9px] text-red-400 whitespace-pre-wrap font-mono max-w-[680px]">
              {notice}
            </pre>
          )}
        </div>
        <div className="flex space-x-4">
          <button
            onClick={handleExportCsv}
            disabled={loading || filteredTasks.length === 0}
            className="btn-secondary !px-4 disabled:opacity-40 disabled:cursor-not-allowed flex items-center"
          >
            <Download className="w-4 h-4 mr-2" />
            Export_CSV
          </button>
          <button
            onClick={fetchTasks}
            className="btn-secondary !px-4 flex items-center"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            disabled
            className="btn-secondary !px-4 text-red-900 border-red-900/30 opacity-40 cursor-not-allowed flex items-center"
          >
            Clear_All
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between bg-panel border border-border p-2 gap-4">
        <div className="flex space-x-1 shrink-0">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-4 py-1.5 text-[9px] font-bold uppercase tracking-wider border transition ${
              statusFilter === 'all'
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'text-textMain/40 border-transparent hover:text-textMain'
            }`}
          >
            All_Tasks
          </button>
          <button
            onClick={() => setStatusFilter('success')}
            className={`px-4 py-1.5 text-[9px] font-bold uppercase tracking-wider border transition ${
              statusFilter === 'success'
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'text-textMain/40 border-transparent hover:text-textMain'
            }`}
          >
            Completed
          </button>
          <button
            onClick={() => setStatusFilter('failed')}
            className={`px-4 py-1.5 text-[9px] font-bold uppercase tracking-wider border transition ${
              statusFilter === 'failed'
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'text-textMain/40 border-transparent hover:text-textMain'
            }`}
          >
            Failed
          </button>
          <button
            onClick={() => setStatusFilter('running')}
            className={`px-4 py-1.5 text-[9px] font-bold uppercase tracking-wider border transition ${
              statusFilter === 'running'
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'text-textMain/40 border-transparent hover:text-textMain'
            }`}
          >
            Running
          </button>
        </div>

        <div className="relative w-full max-w-[320px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-textMain/40" />
          <input
            type="text"
            placeholder="FILTER_BY_IMAGE_NAME..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full !pl-8 !py-1.5"
          />
        </div>
      </div>

      <div className="flex-1 overflow-hidden border border-border bg-panel">
        <div className="w-full h-full overflow-auto">
          <table className="w-full text-left font-mono text-[10px] min-w-[920px]">
            <thead className="bg-background/40 border-b border-border text-textMain/60 sticky top-0 z-10">
              <tr>
                <th className="px-6 py-4">JOB_ID</th>
                <th className="px-6 py-4">IMAGE_IDENTITY</th>
                <th className="px-6 py-4">SOURCE -&gt; TARGET</th>
                <th className="px-6 py-4">DURATION</th>
                <th className="px-6 py-4">TIMESTAMP</th>
                <th className="px-6 py-4">STATE</th>
                <th className="px-6 py-4 text-right">ACTION</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-textMain/60">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-10">
                    <div className="flex items-center justify-center text-textMain/40 text-[10px] uppercase italic">
                      <Loader2 className="w-4 h-4 mr-2 text-primary animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              ) : filteredTasks.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-10">
                    <div className="text-center text-textMain/40 text-[10px] uppercase italic">
                      No_tasks_found
                    </div>
                  </td>
                </tr>
              ) : (
                filteredTasks.map(task => {
                  const identity = getImageIdentity(task.target_ref || task.source_ref);
                  const srcHost = getRegistryHost(task.source_ref);
                  const dstHost = getRegistryHost(task.target_ref);

                  return (
                    <tr
                      key={task.id}
                      className="hover:bg-background/40 group cursor-pointer"
                      onClick={() => openTaskDetail(task.id)}
                    >
                      <td className="px-6 py-4 text-primary font-bold">
                        <span className="block max-w-[240px] truncate">{task.id}</span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-textMain font-bold break-all">{identity.primary}</span>
                          {identity.secondary ? (
                            <span className="text-[8px] text-textMain/40">{identity.secondary}</span>
                          ) : (
                            <span className="text-[8px] text-textMain/40">---</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">{srcHost} -&gt; {dstHost}</td>
                      <td className="px-6 py-4">{getDurationText(task.created_at, task.ended_at)}</td>
                      <td className="px-6 py-4 text-textMain/40">{formatDateTime(task.created_at)}</td>
                      <td className="px-6 py-4">
                        <span className="flex items-center">
                          <span className="mr-2">{getStatusIcon(task.status)}</span>
                          {getStatusText(task.status)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <ChevronRight className="inline-block w-4 h-4 text-textMain/30 group-hover:text-primary transition" />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detailOpen && (
        <div
          className="absolute inset-0 z-30 bg-black/70 flex items-center justify-center p-6"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeTaskDetail();
          }}
        >
          <div className="w-full max-w-5xl bg-panel border border-border overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-border bg-panel">
              <div className="min-w-0">
                <div className="flex items-center space-x-3">
                  <h3 className="text-[12px] font-bold text-primary uppercase tracking-widest truncate">
                    Task_Details: {selectedTask?.id || '---'}
                  </h3>
                  {selectedTask?.status && (
                    <span className="flex items-center space-x-2">
                      {getStatusIcon(selectedTask.status)}
                      {getStatusText(selectedTask.status)}
                    </span>
                  )}
                  {loadingDetails && <Loader2 className="w-4 h-4 text-primary animate-spin" />}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[9px] text-textMain/40 uppercase">
                  <span>Created_at: {formatDateTime(selectedTask?.created_at)}</span>
                  <span>Duration: {getDurationText(selectedTask?.created_at, selectedTask?.ended_at)}</span>
                  {selectedTask?.cancel_requested && <span className="text-red-500">Cancel_requested</span>}
                </div>
                {notice && (
                  <pre className="mt-2 text-[9px] text-red-400 whitespace-pre-wrap font-mono">
                    {notice}
                  </pre>
                )}
              </div>

              <div className="flex items-center space-x-3 shrink-0">
                <button
                  onClick={handleDownloadLog}
                  disabled={!selectedTask?.logs || selectedTask.logs.length === 0}
                  className="btn-secondary !px-4 disabled:opacity-40 disabled:cursor-not-allowed flex items-center"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download_Log
                </button>
                <button onClick={closeTaskDetail} className="btn-secondary !px-3 flex items-center">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-background border border-border p-4">
                <div className="text-[9px] text-textMain/40 uppercase mb-2">Source_Ref</div>
                <div className="text-[10px] text-textMain break-all">{selectedTask?.source_ref || '---'}</div>
              </div>
              <div className="bg-background border border-border p-4">
                <div className="text-[9px] text-textMain/40 uppercase mb-2">Target_Ref</div>
                <div className="text-[10px] text-textMain break-all">{selectedTask?.target_ref || '---'}</div>
              </div>
              {selectedTask?.error_summary && (
                <div className="bg-background border border-border p-4 lg:col-span-2">
                  <div className="text-[9px] text-textMain/40 uppercase mb-2">Error_Summary</div>
                  <div className="text-[10px] text-red-500 break-all">{selectedTask.error_summary}</div>
                </div>
              )}
            </div>

            <div className="px-4 pb-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[10px] font-bold text-textMain/60 uppercase tracking-widest flex items-center">
                  <Terminal className="w-3.5 h-3.5 mr-2 text-primary" />
                  Task_Execution_Logs
                </h4>
              </div>
              <div
                ref={logRef}
                className="h-[360px] bg-background/40 border border-border p-4 font-mono text-[10px] overflow-y-auto scrollbar-hide space-y-1 scroll-smooth"
              >
                {loadingDetails ? (
                  <div className="flex items-center justify-center h-20 text-textMain/40 text-[10px] uppercase italic">
                    Loading_Logs...
                  </div>
                ) : selectedTask?.logs && selectedTask.logs.length > 0 ? (
                  selectedTask.logs.map((log, i) => (
                    <div key={i} className="flex">
                      <span className="text-textMain leading-relaxed break-all whitespace-pre-wrap">{log}</span>
                    </div>
                  ))
                ) : (
                  <div className="text-textMain/40 italic text-[9px] uppercase tracking-widest">No logs available for this task</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryView;
