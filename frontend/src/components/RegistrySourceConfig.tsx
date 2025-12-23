import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { 
  CheckCircle2, 
  Loader2, 
  ChevronRight, 
  ChevronLeft, 
  Search, 
  Database, 
  Key, 
  Globe, 
  Tag,
  AlertCircle
} from 'lucide-react';
import api from '../api';
import axios from 'axios';

import type { Credential, NodeDraft } from '../types';

interface RegistrySourceConfigProps {
  nodeId: string;
  initialDraft: NodeDraft;
  credentials: Credential[];
  onUpdateDraft: (draft: Partial<NodeDraft>) => void;
}

// Helper for caching
const createCache = <T,>() => new Map<string, { expiresAt: number; data: T }>();

export const RegistrySourceConfig: React.FC<RegistrySourceConfigProps> = ({
  nodeId,
  initialDraft,
  credentials,
  onUpdateDraft,
}) => {
  // --- State ---
  const [mode, setMode] = useState<'wizard' | 'manual'>('wizard');
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wizard Data
  const [selectedCredId, setSelectedCredId] = useState(initialDraft.credId);
  const [namespace, setNamespace] = useState('');
  const [repositories, setRepositories] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [selectedTag, setSelectedTag] = useState('');
  
  // Manual Data
  const [manualImageRef, setManualImageRef] = useState(initialDraft.image);
  const [manualResolvedTag, setManualResolvedTag] = useState<string | null>(null);
  const [manualTags, setManualTags] = useState<string[]>([]);
  const [manualTagsLoading, setManualTagsLoading] = useState(false);
  const [manualTagsError, setManualTagsError] = useState<string | null>(null);
  const [manualTagQuery, setManualTagQuery] = useState('');
  const [manualCredentialError, setManualCredentialError] = useState<string | null>(null);

  // Search Queries
  const [repoQuery, setRepoQuery] = useState('');
  const [tagQuery, setTagQuery] = useState('');

  // Caches
  const reposCache = useRef(createCache<string[]>());
  const tagsCache = useRef(createCache<string[]>());

  // Load draft from local storage on mount
  useEffect(() => {
    const saved = localStorage.getItem(`registry_draft_${nodeId}`);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.mode) setMode(parsed.mode);
        if (parsed.step) setStep(parsed.step);
        if (parsed.selectedCredId) setSelectedCredId(parsed.selectedCredId);
        if (parsed.namespace) setNamespace(parsed.namespace);
        if (parsed.selectedRepo) setSelectedRepo(parsed.selectedRepo);
        if (parsed.selectedTag) setSelectedTag(parsed.selectedTag);
        if (parsed.manualImageRef) setManualImageRef(parsed.manualImageRef);
      } catch (e) {
        console.error('Failed to load draft', e);
      }
    } else {
      // Initialize from props if no draft
      if (initialDraft.image && !initialDraft.image.startsWith('archive://')) {
        // Try to parse image to populate wizard if possible
        // For now, simpler to default to Manual if image is present? 
        // Or try to reverse engineer. Let's default to Manual if image exists and is not empty
        if (initialDraft.image) {
           setMode('manual');
           setManualImageRef(initialDraft.image);
        }
      }
    }
  }, [nodeId, initialDraft.image]);

  // Save draft to local storage on change
  useEffect(() => {
    const state = {
      mode,
      step,
      selectedCredId,
      namespace,
      selectedRepo,
      selectedTag,
      manualImageRef
    };
    localStorage.setItem(`registry_draft_${nodeId}`, JSON.stringify(state));
    
    // Sync back to parent draft
    if (mode === 'manual') {
      onUpdateDraft({ 
        credId: selectedCredId, 
        image: manualImageRef 
      });
    } else {
      if (selectedRepo && selectedTag) {
        const cred = credentials.find(c => c.id === selectedCredId);
        const host = normalizeRegistryHost(cred?.registry || '');
        let img = `${selectedRepo}:${selectedTag}`;
        if (host && !isDockerHubHost(host)) {
          img = `${host}/${selectedRepo}:${selectedTag}`;
        }
        onUpdateDraft({ 
          credId: selectedCredId, 
          image: img 
        });
      }
    }
  }, [mode, step, selectedCredId, namespace, selectedRepo, selectedTag, manualImageRef, nodeId, credentials, onUpdateDraft]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      localStorage.removeItem(`registry_draft_${nodeId}`);
    };
  }, [nodeId]);

  // --- Helpers ---
  const getCached = <T,>(cache: Map<string, { expiresAt: number; data: T }>, key: string) => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  };

  const setCached = <T,>(cache: Map<string, { expiresAt: number; data: T }>, key: string, data: T, ttl: number) => {
    cache.set(key, { expiresAt: Date.now() + ttl, data });
  };

  const normalizeRegistryHost = (registry: string) => {
    return registry.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  };

  const isDockerHubHost = (host: string) => {
    const h = host.toLowerCase();
    return h === '' || h === 'docker.io' || h === 'index.docker.io' || h === 'registry-1.docker.io';
  };

  const parseDockerHubRef = useCallback(
    (rawRef: string) => {
      const ref = rawRef.trim();
      if (!ref) return { ok: false as const, reason: 'empty' as const };
      if (ref.includes('@')) {
        return { ok: false as const, reason: 'digest' as const };
      }

      const parts = ref.split('/').filter(Boolean);
      if (parts.length === 0) return { ok: false as const, reason: 'invalid' as const };

      const first = parts[0] ?? '';
      const firstLooksLikeHost =
        first.includes('.') || first.includes(':') || first.toLowerCase() === 'localhost' || isDockerHubHost(first);

      let host = '';
      let pathParts = parts;
      if (firstLooksLikeHost) {
        host = normalizeRegistryHost(first);
        pathParts = parts.slice(1);
      }

      if (host && !isDockerHubHost(host)) {
        return { ok: false as const, reason: 'non_dockerhub' as const };
      }

      if (pathParts.length === 0) return { ok: false as const, reason: 'invalid' as const };

      const last = pathParts[pathParts.length - 1] ?? '';
      const [lastName, lastTag] = last.split(':');
      const repoParts = pathParts.slice(0, -1).concat(lastName ? [lastName] : []);
      const rawRepo = repoParts.filter(Boolean).join('/');
      if (!rawRepo) return { ok: false as const, reason: 'invalid' as const };

      const repo = rawRepo.includes('/') ? rawRepo : `library/${rawRepo}`;
      const tag = lastTag ? lastTag.trim() : '';
      return { ok: true as const, host: host || 'docker.io', repo, tag };
    },
    [],
  );

  const dockerHubCredentials = useMemo(
    () => credentials.filter((cred) => isDockerHubHost(normalizeRegistryHost(cred.registry || ''))),
    [credentials],
  );

  useEffect(() => {
    if (mode !== 'wizard') return;
    if (!selectedCredId) return;
    if (dockerHubCredentials.some((c) => c.id === selectedCredId)) return;
    setSelectedCredId('');
  }, [dockerHubCredentials, mode, selectedCredId]);

  const manualSelectedCredentialMissing = useMemo(() => {
    if (mode !== 'manual') return false;
    if (!selectedCredId) return false;
    return !credentials.some((c) => c.id === selectedCredId);
  }, [credentials, mode, selectedCredId]);

  useEffect(() => {
    if (mode !== 'manual') return;
    if (!manualSelectedCredentialMissing) return;
    setManualCredentialError('Selected credential is no longer available. Please re-select or use NO_AUTHENTICATION.');
    setSelectedCredId('');
  }, [manualSelectedCredentialMissing, mode]);

  const selectedCredentialHost = useMemo(() => {
    const cred = credentials.find((c) => c.id === selectedCredId);
    return normalizeRegistryHost(cred?.registry || '');
  }, [credentials, selectedCredId]);

  const selectedCredentialSupportsDockerHub = useMemo(() => {
    if (!selectedCredId) return true;
    return isDockerHubHost(selectedCredentialHost);
  }, [selectedCredId, selectedCredentialHost]);

  const currentRegistryHost = useMemo(() => {
    const cred = credentials.find(c => c.id === selectedCredId);
    return normalizeRegistryHost(cred?.registry || '');
  }, [selectedCredId, credentials]);

  const isDockerHub = useMemo(() => isDockerHubHost(currentRegistryHost), [currentRegistryHost]);

  // --- API Actions ---
  const fetchRepositories = useCallback(async (credId: string, ns: string) => {
    const cacheKey = `repos|${credId}|${ns}`;
    const cached = getCached(reposCache.current, cacheKey);
    if (cached) {
      setRepositories(cached);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/registry/repositories', { 
        params: ns ? { cred_id: credId, namespace: ns } : { cred_id: credId } 
      });
      const list = Array.isArray(res.data?.repositories) ? res.data.repositories : [];
      setRepositories(list);
      setCached(reposCache.current, cacheKey, list, 3 * 60 * 1000);
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.data?.error) {
        setError(e.response.data.error);
      } else {
        setError('Failed to fetch repositories');
      }
      setRepositories([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTags = useCallback(async (credId: string, repo: string) => {
    const cacheKey = `tags|${credId}|${repo}`;
    const cached = getCached(tagsCache.current, cacheKey);
    if (cached) {
      setTags(cached);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/registry/tags', { 
        params: { cred_id: credId, repo: repo } 
      });
      const list = Array.isArray(res.data?.tags) ? res.data.tags : [];
      setTags(list);
      setCached(tagsCache.current, cacheKey, list, 2 * 60 * 1000);
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.data?.error) {
        setError(e.response.data.error);
      } else {
        setError('Failed to fetch tags');
      }
      setTags([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchManualTags = useCallback(
    async (credId: string, repo: string) => {
      const cacheKey = `tags|${credId}|${repo}`;
      const cached = getCached(tagsCache.current, cacheKey);
      if (cached) {
        setManualTags(cached);
        setManualTagsError(null);
        return;
      }

      setManualTagsLoading(true);
      setManualTagsError(null);
      try {
        const res = await api.get('/registry/tags', {
          params: { cred_id: credId, repo },
        });
        const list = Array.isArray(res.data?.tags) ? res.data.tags : [];
        setManualTags(list);
        setCached(tagsCache.current, cacheKey, list, 2 * 60 * 1000);
      } catch (e) {
        if (axios.isAxiosError(e) && e.response?.data?.error) {
          setManualTagsError(e.response.data.error);
        } else {
          setManualTagsError('Failed to fetch tags');
        }
        setManualTags([]);
      } finally {
        setManualTagsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (mode !== 'manual') return;
    const parsed = parseDockerHubRef(manualImageRef || '');
    if (!parsed.ok) {
      setManualResolvedTag(null);
      setManualTags([]);
      setManualTagsError(null);
      setManualTagsLoading(false);
      return;
    }

    setManualResolvedTag(parsed.tag || null);

    const handle = window.setTimeout(() => {
      if (!selectedCredentialSupportsDockerHub) {
        setManualTags([]);
        setManualTagsError(null);
        setManualTagsLoading(false);
        return;
      }
      fetchManualTags(selectedCredId, parsed.repo);
    }, 450);

    return () => window.clearTimeout(handle);
  }, [fetchManualTags, manualImageRef, mode, parseDockerHubRef, selectedCredId, selectedCredentialSupportsDockerHub]);

  const manualFilteredTags = useMemo(() => {
    const q = manualTagQuery.trim().toLowerCase();
    if (!q) return manualTags;
    return manualTags.filter((t) => t.toLowerCase().includes(q));
  }, [manualTagQuery, manualTags]);

  const applyManualTag = useCallback(
    (tag: string) => {
      const parsed = parseDockerHubRef(manualImageRef || '');
      if (!parsed.ok) return;
      const includeHost = manualImageRef.trim().toLowerCase().startsWith('docker.io/');
      const base = includeHost ? `docker.io/${parsed.repo}` : parsed.repo;
      const next = tag ? `${base}:${tag}` : base;
      setManualResolvedTag(tag || null);
      setManualImageRef(next);
    },
    [manualImageRef, parseDockerHubRef],
  );

  // --- Handlers ---
  const handleStep1Next = () => {
    // If credential is empty, that's fine (anonymous), but usually for private repos we need it.
    // Proceed to Step 2
    setStep(2);
    // If not DockerHub, we can auto-fetch repos if we don't need namespace
    if (!isDockerHub) {
      fetchRepositories(selectedCredId, '');
    } else {
      setRepositories([]); // Reset
    }
  };

  const handleStep2Next = () => {
    setStep(3);
  };

  const handleStep3Next = () => {
    if (selectedRepo) {
      setStep(4);
      fetchTags(selectedCredId, selectedRepo);
    }
  };

      // --- Render ---
  return (
    <div className="flex flex-col space-y-4">
      {/* Mode Toggle */}
      <div className="bg-panel p-1 border border-border rounded flex gap-1">
        <button
          onClick={() => setMode('wizard')}
          className={`
            flex-1 flex items-center justify-center gap-2 py-1.5 rounded text-[10px] uppercase font-bold tracking-wider transition-all
            ${mode === 'wizard' 
              ? 'bg-primary text-black shadow-sm' 
              : 'text-textMain/60 hover:text-textMain hover:bg-primary/10'}
          `}
        >
          <Database className="w-3.5 h-3.5" />
          Wizard Mode
        </button>
        <button
          onClick={() => setMode('manual')}
          className={`
            flex-1 flex items-center justify-center gap-2 py-1.5 rounded text-[10px] uppercase font-bold tracking-wider transition-all
            ${mode === 'manual' 
              ? 'bg-primary text-black shadow-sm' 
              : 'text-textMain/60 hover:text-textMain hover:bg-primary/10'}
          `}
        >
          <Search className="w-3.5 h-3.5" />
          Manual Input
        </button>
      </div>

      <div className="space-y-4">
        {/* Manual Mode */}
        {mode === 'manual' && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="space-y-2">
              <label className="text-[9px] text-textMain/60 uppercase font-bold tracking-wider">Registry Credential (Optional)</label>
              <div className="relative">
                <Key className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textMain/40" />
                <select
                  value={selectedCredId || ''}
                  onChange={(e) => setSelectedCredId(e.target.value)}
                  className="w-full bg-background border border-border !pl-9 !pr-3 !py-2.5 text-[11px] text-textMain font-mono focus:border-primary outline-none transition-colors appearance-none"
                >
                  <option value="">NO_AUTHENTICATION</option>
                  {credentials.map((cred) => (
                    <option key={cred.id} value={cred.id}>{cred.name} ({cred.registry})</option>
                  ))}
                </select>
              </div>
              <p className="text-[9px] text-textMain/60">
                Manual mode supports selecting any credential. Wizard mode is limited to Docker Hub.
              </p>
              {credentials.length === 0 && (
                <div className="p-2 border border-border bg-background/40 text-[10px] text-textMain/60 rounded">
                  No credentials found in Vault.
                </div>
              )}
              {manualCredentialError && (
                <div className="p-2 border border-red-500/30 bg-red-500/5 text-red-400 text-[10px] flex items-start gap-2 rounded">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <div className="flex-1">{manualCredentialError}</div>
                  <button
                    type="button"
                    onClick={() => setManualCredentialError(null)}
                    className="text-[10px] text-primary hover:underline whitespace-nowrap"
                  >
                    DISMISS
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-[9px] text-textMain/60 uppercase font-bold tracking-wider">Image Reference</label>
              <div className="relative">
                <Globe className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textMain/40" />
                <input
                  type="text"
                  value={manualImageRef || ''}
                  onChange={(e) => setManualImageRef(e.target.value)}
                  placeholder="e.g. docker.io/library/nginx:latest"
                  className="w-full bg-background border border-border !pl-9 !pr-3 !py-2.5 text-[11px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                />
              </div>
              {(() => {
                const parsed = parseDockerHubRef(manualImageRef || '');
                if (!manualImageRef?.trim()) {
                  return (
                    <p className="text-[9px] text-textMain/60">
                      Enter a Docker Hub image reference. Examples: <span className="text-textMain font-mono">nginx</span>,{' '}
                      <span className="text-textMain font-mono">library/nginx</span>,{' '}
                      <span className="text-textMain font-mono">docker.io/library/nginx:latest</span>.
                    </p>
                  );
                }
                if (!parsed.ok) {
                  if (parsed.reason === 'digest') {
                    return <p className="text-[9px] text-textMain/60">Tag discovery is not available for digest references.</p>;
                  }
                  if (parsed.reason === 'non_dockerhub') {
                    return <p className="text-[9px] text-textMain/60">Manual tag discovery only supports Docker Hub (docker.io).</p>;
                  }
                  return <p className="text-[9px] text-textMain/60">Enter a valid Docker Hub image reference.</p>;
                }

                if (!selectedCredentialSupportsDockerHub) {
                  return (
                    <p className="text-[9px] text-textMain/60">
                      Tag discovery is available only when using a Docker Hub credential (docker.io) or NO_AUTHENTICATION.
                    </p>
                  );
                }

                const tagExists = parsed.tag ? manualTags.includes(parsed.tag) : null;

                return (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-[9px] text-textMain/60">
                      <span className="uppercase font-bold tracking-wider">Resolved Repo</span>
                      <span className="text-textMain font-mono">{parsed.repo}</span>
                      {manualTagsLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
                      {!manualTagsLoading && manualTagsError && <AlertCircle className="w-3.5 h-3.5 text-red-400" />}
                      {!manualTagsLoading && !manualTagsError && manualTags.length > 0 && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                    </div>

                    {manualTagsError && (
                      <div className="p-2 border border-red-500/30 bg-red-500/5 text-red-400 text-[10px] flex items-start gap-2 rounded">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <div>{manualTagsError}</div>
                      </div>
                    )}

                    {!manualTagsError && manualTags.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[9px] text-textMain/60 uppercase font-bold tracking-wider">Select Tag</div>
                          <button
                            type="button"
                            onClick={() => fetchManualTags(selectedCredId, parsed.repo)}
                            disabled={manualTagsLoading}
                            className="text-[9px] text-primary hover:underline disabled:opacity-50"
                          >
                            REFRESH
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="text"
                            value={manualTagQuery}
                            onChange={(e) => setManualTagQuery(e.target.value)}
                            placeholder="Filter tags..."
                            className="w-full bg-background border border-border !px-3 !py-2 text-[10px] text-textMain focus:border-primary outline-none transition-colors"
                          />
                          <select
                            value={manualResolvedTag || ''}
                            onChange={(e) => applyManualTag(e.target.value)}
                            className="w-full bg-background border border-border !px-3 !py-2 text-[10px] text-textMain font-mono appearance-none focus:border-primary outline-none transition-colors"
                          >
                            <option value="">(Select Tag)</option>
                            {manualFilteredTags.slice(0, 400).map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </div>

                        {tagExists === false && (
                          <div className="text-[10px] text-red-400 flex items-center gap-2">
                            <AlertCircle className="w-3.5 h-3.5" />
                            <span>Tag not found for this repository. Pick an existing tag from the list.</span>
                          </div>
                        )}
                        {tagExists === true && (
                          <div className="text-[10px] text-green-500 flex items-center gap-2">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Image tag exists.</span>
                          </div>
                        )}
                        {tagExists === null && (
                          <div className="text-[10px] text-textMain/60">
                            Select a tag to complete the image reference.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Wizard Mode */}
        {mode === 'wizard' && (
          <div className="space-y-4">
            {/* Step Indicators */}
            <div className="flex items-center justify-between mb-6 relative">
              <div className="absolute top-1/2 left-0 w-full h-0.5 bg-border -z-10" />
              {[1, 2, 3, 4].map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    if (s < step) setStep(s as 1|2|3|4);
                  }}
                  disabled={s > step}
                  className={`
                    flex flex-col items-center justify-center gap-1 bg-transparent px-2
                    ${s === step ? 'text-primary scale-110' : s < step ? 'text-green-500 cursor-pointer' : 'text-textMain/40'}
                    transition-all duration-200
                  `}
                >
                  <div className={`
                    w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border
                    ${s === step ? 'border-primary bg-transparent' : s < step ? 'border-green-500 bg-transparent' : 'border-border bg-transparent'}
                  `}>
                    {s < step ? <CheckCircle2 className="w-3.5 h-3.5" /> : s}
                  </div>
                  <span className="text-[8px] font-bold uppercase tracking-wider">
                    {s === 1 ? 'Auth' : s === 2 ? 'Namespace' : s === 3 ? 'Repo' : 'Tag'}
                  </span>
                </button>
              ))}
            </div>

            {/* Steps Content */}
            <div className="min-h-[300px]">
              {/* Step 1: Auth */}
              {step === 1 && (
                <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="text-[11px] font-bold text-textMain">Step 1: Docker Hub Authentication (docker.io only)</div>
                  <p className="text-[10px] text-textMain/60">
                    Wizard mode is restricted to Docker Hub (docker.io).
                    Select a Docker Hub credential from Vault for private repositories or better rate limits, or use "No Authentication" for public images.
                  </p>
                  
                  <div className="space-y-2">
                    <label className="text-[9px] text-textMain/60 uppercase font-bold tracking-wider">Docker Hub Credential</label>
                    <div className="relative">
                      <Key className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textMain/40" />
                      <select
                        value={selectedCredId}
                        onChange={(e) => setSelectedCredId(e.target.value)}
                        className="w-full bg-background border border-border !pl-9 !pr-3 !py-3 text-[11px] text-textMain font-mono focus:border-primary outline-none transition-colors appearance-none cursor-pointer hover:border-primary/50"
                      >
                        <option value="">NO_AUTHENTICATION</option>
                        {dockerHubCredentials.map((cred) => (
                          <option key={cred.id} value={cred.id}>{cred.name} ({cred.registry})</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="pt-4 flex justify-end">
                    <button
                      onClick={handleStep1Next}
                      className="btn-primary !py-2 !px-6 flex items-center gap-2"
                    >
                      NEXT STEP <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* Step 2: Namespace (Load) */}
              {step === 2 && (
                <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="text-[11px] font-bold text-textMain">Step 2: Locate Namespace</div>
                  
                  {isDockerHub ? (
                    <div className="space-y-3">
                      <p className="text-[10px] text-textMain/60">
                        For Docker Hub, you must specify a namespace (user or organization) to list repositories.
                        Examples: <span className="text-textMain font-mono">library</span> (official), <span className="text-textMain font-mono">bitnami</span>, etc.
                      </p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={namespace}
                          onChange={(e) => setNamespace(e.target.value)}
                          placeholder="e.g. library"
                          onKeyDown={(e) => e.key === 'Enter' && namespace && fetchRepositories(selectedCredId, namespace)}
                          className="flex-1 bg-background border border-border px-3 py-2.5 text-[11px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                        />
                        <button
                          onClick={() => fetchRepositories(selectedCredId, namespace)}
                          disabled={loading || !namespace}
                          className="btn-secondary !py-2 !px-4"
                        >
                          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'LOAD'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-[10px] text-textMain/60">
                        Listing repositories from <strong>{currentRegistryHost}</strong>...
                      </p>
                      {loading && (
                        <div className="flex items-center gap-2 text-[10px] text-primary">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Fetching catalog...
                        </div>
                      )}
                    </div>
                  )}

                  {error && (
                    <div className="p-3 border border-red-500/30 bg-red-500/5 text-red-400 text-[10px] flex items-start gap-2 rounded">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <div>{error}</div>
                    </div>
                  )}

                  {repositories.length > 0 && (
                    <div className="p-3 border border-primary/20 bg-primary/5 text-primary text-[10px] flex items-center gap-2 rounded">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <div>Found {repositories.length} repositories</div>
                    </div>
                  )}

                  <div className="pt-4 flex justify-between items-center">
                    <button onClick={() => setStep(1)} className="text-[10px] text-textMain/60 hover:text-textMain flex items-center gap-1">
                      <ChevronLeft className="w-3 h-3" /> BACK
                    </button>
                    <button
                      onClick={handleStep2Next}
                      disabled={loading || (isDockerHub && repositories.length === 0)}
                      className={`btn-primary !py-2 !px-6 flex items-center gap-2 ${loading || (isDockerHub && repositories.length === 0) ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      NEXT STEP <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* Step 3: Select Repo */}
              {step === 3 && (
                <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="text-[11px] font-bold text-textMain">Step 3: Select Repository</div>
                  
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textMain/40" />
                    <input
                      type="text"
                      value={repoQuery}
                      onChange={(e) => setRepoQuery(e.target.value)}
                      placeholder="Filter repositories..."
                      className="w-full bg-background border border-border !pl-9 !pr-3 !py-2 text-[10px] text-textMain focus:border-primary outline-none transition-colors"
                    />
                  </div>

                  <div className="border border-border bg-background/40 h-[240px] overflow-y-auto">
                    {repositories
                      .filter(r => r.toLowerCase().includes(repoQuery.toLowerCase()))
                      .map(repo => (
                        <button
                          key={repo}
                          onClick={() => setSelectedRepo(repo)}
                          className={`w-full text-left px-3 py-2 text-[10px] font-mono border-b border-border/50 transition-colors ${
                            selectedRepo === repo ? 'bg-primary/20 text-primary border-primary/30' : 'text-textMain hover:bg-primary/5'
                          }`}
                        >
                          {repo}
                        </button>
                      ))}
                    {repositories.length === 0 && (
                      <div className="p-4 text-center text-[10px] text-textMain/60">
                        No repositories found. 
                        <br/>
                        <button onClick={() => setStep(2)} className="text-primary hover:underline mt-1">Go back to load</button>
                      </div>
                    )}
                  </div>

                  {/* Manual Repo Entry Fallback */}
                  <div className="pt-2 border-t border-border">
                     <div className="text-[9px] text-textMain/60 mb-1">Or enter repository name manually:</div>
                     <input 
                        type="text" 
                        value={selectedRepo} 
                        onChange={e => setSelectedRepo(e.target.value)}
                        placeholder="e.g. my-app"
                        className="w-full bg-background border border-border px-3 py-2 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                     />
                  </div>

                  <div className="pt-4 flex justify-between items-center">
                    <button onClick={() => setStep(2)} className="text-[10px] text-textMain/60 hover:text-textMain flex items-center gap-1">
                      <ChevronLeft className="w-3 h-3" /> BACK
                    </button>
                    <button
                      onClick={handleStep3Next}
                      disabled={!selectedRepo}
                      className={`btn-primary !py-2 !px-6 flex items-center gap-2 ${!selectedRepo ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      NEXT STEP <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* Step 4: Select Tag */}
              {step === 4 && (
                <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
                  <div className="text-[11px] font-bold text-textMain">Step 4: Select Tag & Confirm</div>
                  
                  {loading ? (
                    <div className="py-8 flex flex-col items-center justify-center text-textMain/60 gap-2">
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
                      <span className="text-[10px]">Loading tags for <strong>{selectedRepo}</strong>...</span>
                    </div>
                  ) : (
                    <>
                      <div className="relative">
                        <Tag className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textMain/40" />
                        <input
                          type="text"
                          value={tagQuery}
                          onChange={(e) => setTagQuery(e.target.value)}
                          placeholder="Filter tags..."
                          className="w-full bg-background border border-border !pl-9 !pr-3 !py-2 text-[10px] text-textMain focus:border-primary outline-none transition-colors"
                        />
                      </div>

                      <div className="border border-border bg-background/40 h-[180px] overflow-y-auto">
                        {tags
                          .filter(t => t.toLowerCase().includes(tagQuery.toLowerCase()))
                          .map(tag => (
                            <button
                              key={tag}
                              onClick={() => setSelectedTag(tag)}
                              className={`w-full text-left px-3 py-2 text-[10px] font-mono border-b border-border/50 transition-colors ${
                                selectedTag === tag ? 'bg-primary/20 text-primary border-primary/30' : 'text-textMain hover:bg-primary/5'
                              }`}
                            >
                              {tag}
                            </button>
                          ))}
                         {tags.length === 0 && (
                           <div className="p-4 text-center text-[10px] text-textMain/60">
                             No tags found.
                           </div>
                         )}
                      </div>
                      
                      {/* Manual Tag Entry Fallback */}
                      <div className="pt-2">
                         <div className="text-[9px] text-textMain/60 mb-1">Or enter tag manually:</div>
                         <input 
                            type="text" 
                            value={selectedTag} 
                            onChange={e => setSelectedTag(e.target.value)}
                            placeholder="e.g. latest"
                            className="w-full bg-background border border-border px-3 py-2 text-[10px] text-textMain font-mono focus:border-primary outline-none transition-colors"
                         />
                      </div>
                    </>
                  )}

                  {selectedRepo && selectedTag && (
                    <div className="mt-4 p-3 bg-primary/10 border border-primary/30 rounded">
                      <div className="text-[9px] uppercase font-bold text-primary mb-1">Final Preview</div>
                      <div className="text-[12px] font-mono text-textMain break-all">
                        {isDockerHub 
                          ? `${selectedRepo}:${selectedTag}` 
                          : `${currentRegistryHost}/${selectedRepo}:${selectedTag}`
                        }
                      </div>
                    </div>
                  )}

                  <div className="pt-4 flex justify-between items-center">
                    <button onClick={() => setStep(3)} className="text-[10px] text-textMain/60 hover:text-textMain flex items-center gap-1">
                      <ChevronLeft className="w-3 h-3" /> BACK
                    </button>
                    {/* Save is handled by parent, but we can have a visual confirm here if needed, or just let parent Save button work */}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
