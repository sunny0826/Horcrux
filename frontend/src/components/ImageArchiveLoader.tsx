import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Upload, X, FileArchive, CheckCircle2, AlertCircle, Loader2, Trash2, RefreshCw, Merge, AlertTriangle } from 'lucide-react';
import api from '../api';
import axios from 'axios';

// Shared styles
const modalOverlayClassName = [
  'fixed inset-0 bg-black/70 backdrop-blur-[1px]',
  'opacity-0 transition-opacity duration-200',
  'data-[state=open]:opacity-100 data-[state=closed]:opacity-0',
  'z-50',
].join(' ');

const modalShellClassName = [
  'fixed left-1/2 top-1/2 w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2',
  'bg-panel border border-border shadow-2xl z-50',
  'opacity-0 scale-95 transition-[opacity,transform] duration-200',
  'data-[state=open]:opacity-100 data-[state=open]:scale-100',
  'data-[state=closed]:opacity-0 data-[state=closed]:scale-95',
  'focus:outline-none',
].join(' ');

const modalHeaderClassName = 'p-4 border-b border-border bg-panel flex items-center justify-between';
const modalIconTitleClassName = 'text-[11px] font-bold text-primary uppercase tracking-[0.2em]';
const modalCloseBtnClassName =
  'p-1.5 border border-border text-textMain/40 hover:text-primary hover:bg-primary/10 active:bg-primary/10 transition-colors touch-manipulation';

interface ImageArchiveLoaderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type LoadedArchive = {
  id: string;
  name: string;
  size: number;
  created_at: string;
  ref: string;
  architecture?: string;
  os?: string;
  tag?: string;
  digest?: string;
};

export const ImageArchiveLoader: React.FC<ImageArchiveLoaderProps> = ({ open, onOpenChange }) => {
  const [activeTab, setActiveTab] = useState<'load' | 'manage'>('load');
  
  // Load State
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  
  // Manage State
  const [loadedArchives, setLoadedArchives] = useState<LoadedArchive[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  
  // Merge Form
  const [targetName, setTargetName] = useState('');
  const [targetTag, setTargetTag] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchArchives = useCallback(async () => {
    try {
      const res = await api.get('/archives');
      setLoadedArchives(res.data || []);
    } catch (e) {
      console.error('Failed to fetch archives:', e);
    }
  }, []);

  useEffect(() => {
    if (open && activeTab === 'manage') {
      fetchArchives();
    }
  }, [open, activeTab, fetchArchives]);

  // Load Tab Handlers
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFiles = (newFiles: File[]) => {
    setFiles((prev) => [...prev, ...newFiles]);
    setUploadError(null);
    setUploadSuccess(false);
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleUpload = async () => {
    if (files.length === 0) return;
    
    setUploading(true);
    setProgress(0);
    setUploadError(null);
    setUploadSuccess(false);

    const formData = new FormData();
    files.forEach((file) => {
      formData.append('files', file);
    });

    try {
      await axios.post('/api/archives/upload', formData, {
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const p = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            setProgress(p);
          }
        },
      });

      setUploadSuccess(true);
      setFiles([]);
      // Auto switch to manage tab after short delay
      setTimeout(() => {
        setActiveTab('manage');
        fetchArchives();
        setUploadSuccess(false);
      }, 1500);
    } catch (e) {
      console.error('Upload failed:', e);
      setUploadError(axios.isAxiosError(e) ? e.response?.data?.error || e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  // Manage Tab Handlers
  const deleteArchive = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this archive?')) return;
    try {
      await api.delete(`/archives/${id}`);
      fetchArchives();
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      console.error('Delete failed:', e);
      alert('Failed to delete archive');
    }
  };

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedArchives = useMemo(() => {
    return loadedArchives.filter(a => selectedIds.has(a.id));
  }, [loadedArchives, selectedIds]);

  const mergeValidation = useMemo(() => {
    if (selectedArchives.length < 2) return { valid: false, error: "Select at least 2 archives" };
    
    // Check architecture (complementary)
    const archs = new Set(selectedArchives.map(a => a.architecture || 'unknown'));
    if (archs.size !== selectedArchives.length) return { valid: false, error: "Duplicate architectures selected" };

    const name = selectedArchives[0].name;
    const tag = selectedArchives[0].tag;
    
    // Warn but allow if names/tags mismatch (user can edit in next step)
    const nameMismatch = selectedArchives.some(a => a.name !== name);
    if (nameMismatch) return { valid: true, warning: "Selected images have different names" };
    
    const tagMismatch = selectedArchives.some(a => a.tag !== tag);
    if (tagMismatch) return { valid: true, warning: "Selected images have different versions" };

    return { valid: true };
  }, [selectedArchives]);

  const openMergeModal = () => {
    if (selectedArchives.length > 0) {
      // Use common prefix or just the first one as default
      const firstName = selectedArchives[0].name;
      // If names differ, maybe strip suffixes like -arm64, -amd64?
      // Simple heuristic: if names differ, just use the first one but user can edit.
      setTargetName(firstName);
      
      const firstTag = selectedArchives[0].tag;
      setTargetTag(firstTag || 'latest');
      
      setShowMergeModal(true);
      setMergeError(null);
    }
  };

  const handleMerge = async () => {
    setMerging(true);
    setMergeError(null);
    try {
      await api.post('/archives/merge', {
        ids: Array.from(selectedIds),
        target_name: targetName,
        target_tag: targetTag,
      });
      setShowMergeModal(false);
      setSelectedIds(new Set());
      fetchArchives();
    } catch (e) {
      console.error('Merge failed:', e);
      setMergeError(axios.isAxiosError(e) ? e.response?.data?.error || e.message : 'Merge failed');
    } finally {
      setMerging(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={modalOverlayClassName} />
        <Dialog.Content className={`${modalShellClassName} max-w-[800px] h-[600px] flex flex-col`}>
          <div className={modalHeaderClassName}>
            <div className="flex items-center space-x-2">
              <FileArchive className="w-4 h-4 text-primary" />
              <Dialog.Title className={modalIconTitleClassName}>Image Archive Manager</Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button className={modalCloseBtnClassName} aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex border-b border-border bg-panel">
            <button
              onClick={() => setActiveTab('load')}
              className={`flex-1 py-3 text-[11px] uppercase font-bold tracking-wider transition-colors ${
                activeTab === 'load'
                  ? 'bg-background text-primary border-b-2 border-primary'
                  : 'text-textMain/60 hover:text-textMain'
              }`}
            >
              Load Archive
            </button>
            <button
              onClick={() => setActiveTab('manage')}
              className={`flex-1 py-3 text-[11px] uppercase font-bold tracking-wider transition-colors ${
                activeTab === 'manage'
                  ? 'bg-background text-primary border-b-2 border-primary'
                  : 'text-textMain/60 hover:text-textMain'
              }`}
            >
              Manage & Merge
            </button>
          </div>

          <div className="flex-1 overflow-hidden bg-panel p-6">
            {activeTab === 'load' && (
              <div className="h-full flex flex-col max-w-2xl mx-auto">
                <div
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`
                    flex-1 border-2 border-dashed rounded-lg flex flex-col items-center justify-center cursor-pointer transition-all duration-200
                    ${isDragging ? 'border-primary bg-primary/5 scale-[0.99]' : 'border-border hover:border-primary/50 hover:bg-background/40'}
                  `}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={(e) => e.target.files && handleFiles(Array.from(e.target.files))}
                    multiple
                    className="hidden"
                    accept=".tar,.tar.gz,.tgz,.zip"
                  />
                  <Upload className={`w-12 h-12 mb-4 ${isDragging ? 'text-primary' : 'text-textMain/40'}`} />
                  <div className="text-xs uppercase font-bold text-textMain/60 mb-2">
                    Click or Drag archive files here
                  </div>
                  <div className="text-[10px] text-textMain/40">
                    Supports .tar, .tar.gz, .zip
                  </div>
                </div>

                {files.length > 0 && (
                  <div className="mt-6 space-y-3">
                    <div className="text-[10px] uppercase font-bold text-textMain/60 flex justify-between items-center">
                      <span>Selected Files ({files.length})</span>
                      <button onClick={() => setFiles([])} className="text-red-500 hover:underline">Clear All</button>
                    </div>
                    <div className="max-h-[150px] overflow-y-auto border border-border bg-background/40 rounded-sm">
                      {files.map((f, i) => (
                        <div key={i} className="flex items-center justify-between p-2 border-b border-border/50 last:border-0">
                          <span className="text-[11px] text-textMain truncate">{f.name}</span>
                          <div className="flex items-center gap-4">
                            <span className="text-[10px] text-textMain/60 font-mono">{(f.size / 1024 / 1024).toFixed(2)} MB</span>
                            <button onClick={(e) => { e.stopPropagation(); removeFile(i); }} className="text-textMain/60 hover:text-red-500">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="flex justify-end pt-2">
                      <button
                        onClick={handleUpload}
                        disabled={uploading}
                        className={`
                          btn-primary !py-2.5 !px-8 flex items-center gap-2
                          ${uploading ? 'opacity-50 cursor-not-allowed' : ''}
                        `}
                      >
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileArchive className="w-4 h-4" />}
                        {uploading ? 'LOADING...' : 'LOAD ARCHIVES'}
                      </button>
                    </div>
                  </div>
                )}

                {uploading && (
                  <div className="mt-4 space-y-1.5">
                    <div className="flex justify-between text-[10px] uppercase font-bold text-textMain/60">
                      <span>Processing...</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="h-1.5 bg-background/40 w-full rounded-full overflow-hidden">
                      <div className="h-full bg-primary transition-all duration-300 ease-out" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                )}

                {uploadError && (
                  <div className="mt-4 p-3 bg-red-900/10 border border-red-900/30 text-red-500 text-[11px] flex items-center gap-2 rounded-sm">
                    <AlertCircle className="w-4 h-4" />
                    {uploadError}
                  </div>
                )}

                {uploadSuccess && (
                  <div className="mt-4 p-3 bg-green-900/10 border border-green-900/30 text-green-500 text-[11px] flex items-center gap-2 rounded-sm">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Archives loaded successfully! Switching to Manage tab...</span>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'manage' && (
              <div className="h-full flex flex-col space-y-4">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-4">
                    <h3 className="text-xs text-textMain/60 uppercase font-bold tracking-wider">Loaded Images</h3>
                    <button onClick={fetchArchives} className="p-1.5 text-textMain/60 hover:text-primary transition-colors">
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  
                  <button
                    onClick={openMergeModal}
                    disabled={!mergeValidation.valid}
                    className={`
                      flex items-center gap-2 px-4 py-1.5 text-[10px] uppercase font-bold tracking-wider border transition-all
                      ${mergeValidation.valid 
                        ? (mergeValidation.warning 
                            ? 'bg-yellow-500/10 border-yellow-500 text-yellow-500 hover:bg-yellow-500/20' 
                            : 'bg-primary/10 border-primary text-primary hover:bg-primary/20')
                        : 'bg-transparent border-border text-textMain/40 cursor-not-allowed'}
                    `}
                    title={mergeValidation.error || mergeValidation.warning}
                  >
                    {mergeValidation.warning && <AlertTriangle className="w-3.5 h-3.5" />}
                    {!mergeValidation.warning && <Merge className="w-3.5 h-3.5" />}
                    Merge Selected ({selectedIds.size})
                  </button>
                </div>

                <div className="flex-1 border border-border bg-background/40 overflow-hidden rounded-sm flex flex-col">
                  {/* Table Header */}
                  <div className="grid grid-cols-[40px_2fr_1fr_1fr_1fr_60px] bg-panel border-b border-border p-2 text-[10px] uppercase font-bold text-textMain/60">
                    <div className="flex justify-center">
                      <input 
                        type="checkbox" 
                        className="accent-primary"
                        checked={loadedArchives.length > 0 && selectedIds.size === loadedArchives.length}
                        onChange={() => {
                          if (selectedIds.size === loadedArchives.length) setSelectedIds(new Set());
                          else setSelectedIds(new Set(loadedArchives.map(a => a.id)));
                        }}
                      />
                    </div>
                    <div>Name</div>
                    <div>Version</div>
                    <div>Arch</div>
                    <div>Size</div>
                    <div className="text-right">Action</div>
                  </div>

                  {/* Table Body */}
                  <div className="overflow-y-auto flex-1">
                    {loadedArchives.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-32 text-textMain/40 text-[10px] uppercase tracking-widest">
                        <span>No archives loaded</span>
                      </div>
                    ) : (
                      loadedArchives.map((archive) => (
                        <div 
                          key={archive.id} 
                          className={`
                            grid grid-cols-[40px_2fr_1fr_1fr_1fr_60px] items-center p-2 border-b border-border/30 text-[11px] hover:bg-background/40 transition-colors
                            ${selectedIds.has(archive.id) ? 'bg-primary/5' : ''}
                          `}
                          onClick={() => toggleSelection(archive.id)}
                        >
                          <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
                            <input 
                              type="checkbox" 
                              checked={selectedIds.has(archive.id)}
                              onChange={() => toggleSelection(archive.id)}
                              className="accent-primary"
                            />
                          </div>
                          <div className="truncate font-medium text-textMain" title={archive.name}>{archive.name}</div>
                          <div className="truncate text-textMain/60 font-mono">{archive.tag || '-'}</div>
                          <div className="truncate text-textMain/60 font-mono">{archive.architecture || '-'}</div>
                          <div className="truncate text-textMain/60 font-mono">{(archive.size / 1024 / 1024).toFixed(2)} MB</div>
                          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => deleteArchive(archive.id)}
                              className="p-1.5 text-textMain/60 hover:text-red-500 hover:bg-red-500/10 rounded-sm transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="p-3 bg-background/40 border border-border rounded-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div className="text-[10px] text-textMain/60 leading-relaxed">
                    <p className="font-bold text-primary mb-1">Merge Requirements:</p>
                    <ul className="list-disc list-inside space-y-0.5">
                      <li>Select at least 2 archives</li>
                      <li>Archives must have the same Image Name and Version</li>
                      <li>Archives must have different Architectures (e.g. amd64 + arm64)</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>

      {/* Merge Preview Modal */}
      {showMergeModal && (
        <Dialog.Root open={showMergeModal} onOpenChange={setShowMergeModal}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60]" />
            <Dialog.Content className="fixed left-1/2 top-1/2 w-[500px] -translate-x-1/2 -translate-y-1/2 bg-panel border border-border shadow-2xl z-[60] p-6 rounded-lg">
              <Dialog.Title className="text-sm font-bold text-primary uppercase tracking-widest mb-6 flex items-center gap-2">
                <Merge className="w-4 h-4" />
                Merge Manifest Preview
              </Dialog.Title>
              
              <div className="space-y-4">
                <div className="bg-background/40 border border-border p-4 rounded-sm space-y-2">
                  <div className="text-[10px] uppercase font-bold text-textMain/60 mb-2">Sources</div>
                  {selectedArchives.map((a, i) => (
                    <div key={i} className="flex justify-between text-[11px] text-textMain">
                      <span>{a.name}:{a.tag}</span>
                      <span className="font-mono text-textMain/60">{a.architecture}</span>
                    </div>
                  ))}
                </div>

                <div className="space-y-3">
                  <div className="text-[10px] uppercase font-bold text-textMain/60">Target Manifest Info</div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] text-textMain/60">Image Name</label>
                      <input 
                        className="w-full"
                        value={targetName}
                        onChange={(e) => setTargetName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-textMain/60">Tag (Version)</label>
                      <input 
                        className="w-full"
                        value={targetTag}
                        onChange={(e) => setTargetTag(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {mergeError && (
                  <div className="text-red-500 text-[10px] flex items-center gap-2">
                    <AlertTriangle className="w-3 h-3" />
                    {mergeError}
                  </div>
                )}

                <div className="flex justify-end gap-3 pt-4 border-t border-border/50">
                  <button 
                    onClick={() => setShowMergeModal(false)}
                    className="px-4 py-2 text-xs font-bold text-textMain/60 hover:text-textMain transition-colors"
                  >
                    CANCEL
                  </button>
                  <button 
                    onClick={handleMerge}
                    disabled={merging}
                    className="px-6 py-2 bg-primary text-black text-xs font-bold hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {merging ? 'MERGING...' : 'CONFIRM MERGE'}
                  </button>
                </div>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </Dialog.Root>
  );
};
