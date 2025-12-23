import { useState, useEffect, useRef } from 'react';
import { 
  Terminal, 
  Cpu, 
  ShieldAlert, 
  History, 
  Settings, 
  User,
  Play,
  Plus,
  Database,
  Filter,
  ArrowRight,
  Workflow,
  ChevronLeft,
  ChevronRight,
  Loader2
} from 'lucide-react';
import Vault from './components/Vault';
import Designer from './components/Designer';
import HistoryView from './components/History';

// 模拟 Lucide 没有的图标，或者使用 Lucide 现有的
const ProjectDiagramIcon = Workflow;

type LatestTask = {
  id: string;
  source_ref: string;
  target_ref: string;
  status: string;
  name?: string;
};

type PipeMeta = {
  id: string;
  name?: string;
  description?: string;
  version?: number;
  updated_at?: string;
};

type PipeDetailNode = {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
};

type PipeDetail = PipeMeta & {
  nodes?: PipeDetailNode[];
  edges?: unknown[];
};

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [stats, setStats] = useState({
    active_threads: 0,
    data_throughput: '0 GB',
    manifest_assets: 0,
    auth_keys: 0
  });
  const [latestTask, setLatestTask] = useState<LatestTask | null>(null);
  const [pipes, setPipes] = useState<PipeMeta[]>([]);
  const [isPipesLoading, setIsPipesLoading] = useState(false);
  const [pipesError, setPipesError] = useState<string | null>(null);
  const [activePipeIndex, setActivePipeIndex] = useState(0);
  const [activePipeDetail, setActivePipeDetail] = useState<PipeDetail | null>(null);
  const [isPipeDetailLoading, setIsPipeDetailLoading] = useState(false);
  const [isPipePreviewVisible, setIsPipePreviewVisible] = useState(true);
  const [logs, setLogs] = useState<{time: string, level: string, msg: string}[]>([
    {time: '09:24:01', level: 'INFO', msg: 'Initializing sync engine...'},
    {time: '09:24:02', level: 'INFO', msg: 'Credential \'aliyun-prod\' validated successfully.'},
  ]);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    } catch (e) {
      console.error('Failed to connect websocket:', e);
      return;
    }
    
    ws.onmessage = (event) => {
      const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
      setLogs(prev => [...prev, {
        time: now,
        level: 'SYNC',
        msg: event.data
      }].slice(-100)); // Keep last 100 logs
    };

    return () => ws?.close();
  }, []);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        setStats(data);

        // Fetch tasks to get the latest one for the flow preview
        const tasksRes = await fetch('/api/tasks');
        const tasksData = await tasksRes.json();
        if (tasksData.tasks && tasksData.tasks.length > 0) {
          setLatestTask(tasksData.tasks[0]);
        }
      } catch (error) {
        console.error('Failed to fetch stats:', error);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeTab !== 'dashboard') return;
    let isCancelled = false;

    const loadPipes = async () => {
      setIsPipesLoading(true);
      setPipesError(null);
      try {
        const res = await fetch('/api/pipes?meta_only=1');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PipeMeta[];
        if (isCancelled) return;
        const list = Array.isArray(data) ? data : [];
        setPipes(list);

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
      } finally {
        if (!isCancelled) setIsPipesLoading(false);
      }
    };

    loadPipes();
    const interval = setInterval(loadPipes, 30000);
    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'dashboard') return;
    if (!pipes[activePipeIndex]?.id) return;
    let isCancelled = false;

    const loadDetail = async () => {
      const id = pipes[activePipeIndex]?.id;
      if (!id) return;
      setIsPipeDetailLoading(true);
      try {
        const res = await fetch(`/api/pipes/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PipeDetail;
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

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const getPipeStatusLabel = (p: PipeMeta) => {
    const v = Number.isFinite(p.version) ? Number(p.version) : 0;
    return v > 0 ? 'SAVED' : 'DRAFT';
  };

  const getPipeDisplayName = (p: PipeMeta | null | undefined) => {
    const name = p?.name?.trim();
    if (name) return name;
    const id = p?.id?.trim();
    return id ? id : 'UNNAMED_PIPE';
  };

  const getPipePreviewModel = (detail: PipeDetail | null) => {
    const nodes = Array.isArray(detail?.nodes) ? detail!.nodes! : [];
    const source = nodes.find((n) => n?.type === 'sourceNode') ?? null;
    const target = nodes.find((n) => n?.type === 'targetNode') ?? null;
    const processors = nodes.filter((n) => n?.type === 'processorNode').length;

    const getNodeLabel = (n: PipeDetailNode | null) => {
      const label = typeof n?.data?.label === 'string' ? n?.data?.label : '';
      return label.trim() ? label.trim() : (n?.id ?? '-');
    };

    return {
      sourceLabel: getNodeLabel(source),
      targetLabel: getNodeLabel(target),
      processorCount: processors,
      nodeCount: nodes.length,
    };
  };

  const openActivePipeInDesigner = () => {
    const id = pipes[activePipeIndex]?.id;
    if (!id) return;
    localStorage.setItem('horcrux_active_pipe_id', id);
    setActiveTab('designer');
  };

  const navItems = [
    { id: 'dashboard', label: 'Core.Dashboard', icon: Cpu },
    { id: 'designer', label: 'Flow.Designer', icon: ProjectDiagramIcon },
    { id: 'vault', label: 'Auth.Vault', icon: ShieldAlert },
    { id: 'history', label: 'Sync.History', icon: History },
    { id: 'config', label: 'Sys.Config', icon: Settings },
  ];

  return (
    <div className="h-screen flex flex-col overflow-hidden relative bg-background text-textMain font-mono">
      <div className="scanline pointer-events-none"></div>

      {/* 顶部导航栏 */}
      <header className="h-16 border-b border-border flex items-center justify-between px-6 bg-[#0d0d0d] z-50 shrink-0">
        <div className="flex items-center space-x-8">
          <div className="flex items-center space-x-3 pr-8 border-r border-border">
            <div className="w-8 h-8 border border-primary flex items-center justify-center">
              <Terminal className="text-primary w-4 h-4" />
            </div>
            <h1 className="text-lg font-bold tracking-widest text-primary">HORCRUX</h1>
          </div>

          <nav className="flex items-center space-x-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center space-x-2 px-4 h-16 transition-all border-b-2 ${
                  activeTab === item.id 
                    ? 'bg-primary/10 text-primary border-primary' 
                    : 'hover:bg-[#111] text-[#666] hover:text-primary border-transparent'
                }`}
              >
                <item.icon className="w-4 h-4" />
                <span className="text-[11px] uppercase tracking-tighter font-bold">{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center space-x-8">
          <div className="hidden lg:flex items-center space-x-4">
            <span className="text-[#444] text-[10px]">ROOT@HORCRUX:~/SYNC_TASKS$</span>
            <span className="animate-pulse w-2 h-4 bg-primary"></span>
          </div>
          
          <div className="flex items-center space-x-6">
            <button className="text-[10px] text-primary hover:bg-primary/10 px-4 py-1.5 border border-primary transition uppercase tracking-widest font-bold">
              [ New_Operation ]
            </button>
            
            <div className="flex items-center space-x-6 pl-6 border-l border-border">
              <div className="flex flex-col items-end">
                <span className="text-[9px] text-dim">● KERNEL_READY</span>
                <span className="text-[8px] text-[#444] mt-0.5">STABLE_v0.1.0</span>
              </div>
              <div className="w-8 h-8 border border-[#333] flex items-center justify-center bg-[#111]">
                <User className="w-4 h-4 text-[#666]" />
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* 主内容区域 */}
      <main className="flex-1 flex flex-col overflow-hidden bg-background">
        <div className="flex-1 overflow-hidden relative">
          {activeTab === 'dashboard' && (
            <div className="absolute inset-0 overflow-y-auto p-8 space-y-8">
              {/* 统计概览 */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: 'Active_Threads', value: stats.active_threads.toString(), sub: 'LATEST: +2_SYNC', color: 'text-primary' },
                  { label: 'Data_Throughput', value: stats.data_throughput, sub: 'RATE: 3.2MB/S', color: 'text-textMain' },
                  { label: 'Manifest_Assets', value: stats.manifest_assets.toString(), sub: 'ARCH: MULTI_SUPPORT', color: 'text-textMain' },
                  { label: 'Auth_Keys', value: stats.auth_keys.toString().padStart(2, '0'), sub: 'WARN: 0_EXPIRING', color: 'text-textMain' },
                ].map((stat, i) => (
                  <div key={i} className="bg-[#111] p-4 border border-border relative group">
                    <div className="text-[#444] text-[10px] uppercase mb-1">{stat.label}</div>
                    <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
                    <div className="text-[9px] text-dim mt-1 font-mono">{stat.sub}</div>
                  </div>
                ))}
              </div>

              {/* 可视化流程预览 */}
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-[#666] uppercase tracking-widest flex items-center">
                    <ProjectDiagramIcon />
                    <span className="ml-2">
                      Pipelines: {pipes.length > 0 ? `${getPipeDisplayName(pipes[activePipeIndex])}` : (latestTask ? (latestTask.name || latestTask.id) : 'Production-Sync-Task')}
                    </span>
                  </h3>
                  <div className="flex space-x-1">
                    <button
                      onClick={() => setActivePipeIndex((prev) => (pipes.length ? (prev - 1 + pipes.length) % pipes.length : prev))}
                      disabled={pipes.length <= 1}
                      className={`w-8 h-8 bg-[#111] border border-border transition flex items-center justify-center ${
                        pipes.length <= 1 ? 'opacity-40 cursor-not-allowed text-[#444]' : 'text-[#666] hover:text-primary'
                      }`}
                      aria-label="Previous pipeline"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={openActivePipeInDesigner}
                      disabled={pipes.length === 0}
                      className={`h-8 px-3 bg-[#111] border border-border transition flex items-center justify-center space-x-2 ${
                        pipes.length === 0 ? 'opacity-40 cursor-not-allowed text-[#444]' : 'text-dim hover:text-primary'
                      }`}
                      aria-label="Open pipeline in designer"
                    >
                      <Play className="w-3 h-3" />
                      <span className="text-[10px] uppercase tracking-widest font-bold">Start</span>
                    </button>
                    <button
                      onClick={() => setActivePipeIndex((prev) => (pipes.length ? (prev + 1) % pipes.length : prev))}
                      disabled={pipes.length <= 1}
                      className={`w-8 h-8 bg-[#111] border border-border transition flex items-center justify-center ${
                        pipes.length <= 1 ? 'opacity-40 cursor-not-allowed text-[#444]' : 'text-[#666] hover:text-primary'
                      }`}
                      aria-label="Next pipeline"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                
                {/* 2025-12-22：按原型布局将 Pipe_Thumbnails 独立成新行，避免与预览区域同一水平线 */}
                <div className="flex flex-col gap-4">
                  <div className="h-72 bg-[#080808] border border-border relative overflow-hidden">
                    <div
                      className={[
                        'absolute inset-0 flex items-center justify-center',
                        'transition-[opacity,transform] duration-300 ease-out',
                        isPipePreviewVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
                      ].join(' ')}
                    >
                      {pipesError ? (
                        <div className="text-[10px] text-[#666] uppercase tracking-widest">
                          FAILED_TO_LOAD_PIPES: {pipesError}
                        </div>
                      ) : isPipesLoading ? (
                        <div className="flex items-center space-x-2 text-[10px] text-[#666] uppercase tracking-widest">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>LOADING_PIPELINES</span>
                        </div>
                      ) : pipes.length === 0 ? (
                        <div className="text-[10px] text-[#666] uppercase tracking-widest">
                          NO_PIPELINES_FOUND
                        </div>
                      ) : (
                        (() => {
                          const activeMeta = pipes[activePipeIndex];
                          const model = getPipePreviewModel(activePipeDetail);
                          return (
                            <div className="w-full h-full p-4 flex flex-col justify-between">
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
                                    <div className="text-[9px] text-[#666] max-w-[520px] truncate">
                                      {activeMeta.description}
                                    </div>
                                  ) : null}
                                </div>

                                <div className="flex items-center space-x-2">
                                  <button
                                    onClick={openActivePipeInDesigner}
                                    className="h-8 px-3 bg-[#0d0d0d] border border-primary/40 text-primary hover:bg-primary/10 active:bg-primary/10 transition flex items-center space-x-2"
                                  >
                                    <Play className="w-3 h-3" />
                                    <span className="text-[10px] uppercase tracking-widest font-bold">Open</span>
                                  </button>
                                </div>
                              </div>

                              <div className="flex items-center justify-center h-full">
                                {isPipeDetailLoading ? (
                                  <div className="flex items-center space-x-2 text-[10px] text-[#666] uppercase tracking-widest">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    <span>LOADING_PREVIEW</span>
                                  </div>
                                ) : (
                                  <div className="flex items-center space-x-10 relative">
                                    <div className="flex flex-col items-center p-4 bg-[#0d0d0d] border border-border w-44">
                                      <Database className="text-primary w-6 h-6 mb-2" />
                                      <span className="text-[10px] font-bold uppercase truncate w-full text-center">
                                        {model.sourceLabel || 'SOURCE'}
                                      </span>
                                      <span className="text-[8px] text-[#444] mt-1 truncate w-full text-center">
                                        NODES: {model.nodeCount}
                                      </span>
                                    </div>

                                    <div className="flex items-center">
                                      <div className="w-14 h-[1px] bg-border relative">
                                        <div className="absolute right-0 -top-1 w-2 h-2 border-r border-t border-primary rotate-45"></div>
                                      </div>
                                    </div>

                                    <div className="flex flex-col items-center p-4 bg-[#111] border border-primary/30 w-44">
                                      <Filter className="text-primary w-6 h-6 mb-2" />
                                      <span className="text-[10px] font-bold text-primary">PROCESSORS</span>
                                      <span className="text-[8px] text-dim mt-1 uppercase">
                                        COUNT: {model.processorCount}
                                      </span>
                                    </div>

                                    <div className="flex items-center">
                                      <div className="w-14 h-[1px] bg-border relative">
                                        <div className="absolute right-0 -top-1 w-2 h-2 border-r border-t border-primary rotate-45"></div>
                                      </div>
                                    </div>

                                    <div className="flex flex-col items-center p-4 bg-[#0d0d0d] border border-border w-44">
                                      <ArrowRight className="text-primary w-6 h-6 mb-2" />
                                      <span className="text-[10px] font-bold uppercase truncate w-full text-center">
                                        {model.targetLabel || 'TARGET'}
                                      </span>
                                      <span className="text-[8px] text-[#444] mt-1 truncate w-full text-center">
                                        EDGES: {Array.isArray(activePipeDetail?.edges) ? activePipeDetail!.edges!.length : '-'}
                                      </span>
                                    </div>
                                  </div>
                                )}
                              </div>

                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-2">
                                  <button className="bg-[#111] border border-border p-2 hover:border-primary transition">
                                    <Plus className="text-primary w-3 h-3" />
                                  </button>
                                  <button className="bg-[#111] border border-border p-2 text-[#444] hover:text-primary transition">
                                    <Database className="w-3 h-3" />
                                  </button>
                                  <button className="bg-[#111] border border-border p-2 text-[#444] hover:text-primary transition">
                                    <Filter className="w-3 h-3" />
                                  </button>
                                </div>
                                <div className="text-[9px] text-[#444] uppercase tracking-widest">
                                  KEY: ← / → SWITCH
                                </div>
                              </div>
                            </div>
                          );
                        })()
                      )}
                    </div>
                  </div>

                  <div className="mt-2">
                    <div className="bg-[#080808] border border-border overflow-hidden">
                      <div className="p-3 border-b border-border flex items-center justify-between">
                        <div className="text-[10px] text-primary uppercase tracking-widest font-bold">Pipe_Thumbnails</div>
                        <div className="text-[9px] text-[#444]">{pipes.length} TOTAL</div>
                      </div>
                      <div className="max-h-72 overflow-y-auto scrollbar-hide">
                        {pipes.length === 0 ? (
                          <div className="p-3 text-[10px] text-[#666] uppercase tracking-widest">
                            {isPipesLoading ? 'LOADING...' : 'EMPTY'}
                          </div>
                        ) : (
                          <div className="bg-[#111] border border-[#222] overflow-hidden">
                            <div className="overflow-x-auto">
                              <table className="w-full text-left font-mono text-[10px]">
                                <thead className="bg-[#1a1a1a] border-b border-[#222] text-[#444]">
                                  <tr>
                                    <th className="px-4 py-3">PIPE_NAME</th>
                                    <th className="px-4 py-3 hidden sm:table-cell">PIPE_ID</th>
                                    <th className="px-4 py-3">VERSION</th>
                                    <th className="px-4 py-3 hidden md:table-cell">UPDATED_AT</th>
                                    <th className="px-4 py-3">STATE</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-[#222] text-[#888]">
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
                                          'hover:bg-[#151515]',
                                          isActive ? 'bg-[#0d0d0d]' : '',
                                        ].join(' ')}
                                      >
                                        <td className="px-4 py-3">
                                          <div className="flex items-center gap-2 min-w-0">
                                            <span className={isActive ? 'text-[#00ff41]' : 'text-[#e0e0e0]'}>
                                              {getPipeDisplayName(p)}
                                            </span>
                                            <span className="hidden lg:inline-block text-[9px] px-2 py-0.5 border border-primary/40 bg-black/30 text-primary uppercase tracking-widest">
                                              {status}
                                            </span>
                                          </div>
                                          <div className="text-[9px] text-[#666] truncate max-w-[420px]">
                                            {p.description || `ID: ${p.id}`}
                                          </div>
                                        </td>
                                        <td className="px-4 py-3 hidden sm:table-cell text-[#666]">
                                          <span className="truncate block max-w-[240px]">{p.id}</span>
                                        </td>
                                        <td className="px-4 py-3">
                                          <span className={version > 0 ? 'text-[#00ff41]' : 'text-[#444]'}>
                                            v{version}
                                          </span>
                                        </td>
                                        <td className="px-4 py-3 hidden md:table-cell text-[#666]">
                                          {p.updated_at || '-'}
                                        </td>
                                        <td className="px-4 py-3">
                                          {isActive ? (
                                            <span className="text-[#00ff41] animate-pulse">ACTIVE</span>
                                          ) : (
                                            <span className="text-[#444]">IDLE</span>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* 实时监控日志 (底部占位) */}
              <div className="bg-[#080808] border border-border p-4 h-48 overflow-y-auto font-mono text-[10px] text-[#666] scrollbar-hide">
                <div className="flex items-center justify-between mb-2 border-b border-border pb-1 sticky top-0 bg-[#080808] z-10">
                  <span className="text-primary uppercase tracking-widest">System_Logs</span>
                  <span className="text-[8px]">WS_STATUS: CONNECTED</span>
                </div>
                <div className="space-y-1">
                  {logs.map((log, i) => (
                    <p key={i}>
                      <span className="text-dim">[{log.time}]</span>{" "}
                      <span className={log.level === 'INFO' ? 'text-white' : 'text-primary'}>{log.level}:</span>{" "}
                      {log.msg}
                    </p>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'designer' && <Designer />}
          {activeTab === 'vault' && <Vault />}
          {activeTab === 'history' && <HistoryView />}

          {activeTab !== 'dashboard' && activeTab !== 'designer' && activeTab !== 'vault' && activeTab !== 'history' && (
            <div className="flex items-center justify-center h-full text-[#444] uppercase tracking-[0.3em]">
              Section: {activeTab} is under development
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
