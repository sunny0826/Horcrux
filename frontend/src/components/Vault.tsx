import { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, Plus, Trash2, Key, Globe, User, Edit3, CheckCircle2, XCircle, Loader2, RefreshCw } from 'lucide-react';
import api from '../api';

interface Credential {
  id: string;
  name: string;
  registry: string;
  username: string;
  password?: string;
  type: string;
}

const Vault: React.FC = () => {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<Record<string, 'success' | 'error' | 'idle'>>({});
  
  const [newCred, setNewCred] = useState<Partial<Credential>>({
    name: '',
    registry: '',
    username: '',
    password: '',
    type: 'dockerhub'
  });

  const registryTemplates = [
    { label: 'Docker Hub', value: 'dockerhub', url: 'index.docker.io' },
    { label: 'GitHub Container Registry', value: 'ghcr', url: 'ghcr.io' },
    { label: 'Aliyun ACR', value: 'acr', url: 'registry.cn-hangzhou.aliyuncs.com' },
    { label: 'Private V2 Registry', value: 'private', url: '' },
  ];

  const handleTypeChange = (type: string) => {
    const template = registryTemplates.find(t => t.value === type);
    setNewCred(prev => ({
      ...prev,
      type,
      registry: template?.url || prev.registry || '',
    }));
  };

  const verifyCredential = useCallback(async (id: string) => {
    setVerificationStatus(prev => ({ ...prev, [id]: 'idle' }));
    
    try {
      await api.post(`/vault/credentials/${id}/verify`);
      setVerificationStatus(prev => ({ ...prev, [id]: 'success' }));
    } catch (error) {
      console.error('Verification failed:', error);
      setVerificationStatus(prev => ({ ...prev, [id]: 'error' }));
    }
  }, []);

  const fetchCredentials = useCallback(async (autoVerify = false) => {
    try {
      const response = await api.get('/vault/credentials');
      const creds = response.data;
      setCredentials(creds);
      
      // 如果需要自动验证（如页面打开时）
      if (autoVerify && creds.length > 0) {
        creds.forEach((c: Credential) => verifyCredential(c.id));
      }
    } catch (error) {
      console.error('Failed to fetch credentials:', error);
    }
  }, [verifyCredential]);

  useEffect(() => {
    fetchCredentials(true); // 打开页面时自动检查所有凭证
  }, [fetchCredentials]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      let savedId = editingId;
      if (editingId) {
        await api.put(`/vault/credentials/${editingId}`, newCred);
      } else {
        const response = await api.post('/vault/credentials', newCred);
        savedId = response.data.id;
      }
      setIsAdding(false);
      setEditingId(null);
      setNewCred({ name: '', registry: '', username: '', password: '', type: 'dockerhub' });
      fetchCredentials();
      
      // 新建或更新后自动触发连通性检查
      if (savedId) {
        verifyCredential(savedId);
      }
    } catch (error) {
      console.error('Failed to save credential:', error);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await api.delete(`/vault/credentials/${id}`);
      fetchCredentials();
      setConfirmDeleteId(null);
      // 清理该 ID 的验证状态
      setVerificationStatus(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (error) {
      console.error('Failed to delete credential:', error);
    } finally {
      setDeletingId(null);
    }
  };

  const handleEdit = (cred: Credential) => {
    setNewCred(cred);
    setEditingId(cred.id);
    setConfirmDeleteId(null);
    setIsAdding(true);
  };

  return (
    <div className="p-8 space-y-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-primary flex items-center">
            <ShieldAlert className="mr-2" /> AUTH.VAULT
          </h2>
          <p className="text-textMain/60 text-xs mt-1 uppercase tracking-widest">Secure_Credential_Storage (AES-256)</p>
        </div>
        {!isAdding && (
          <button 
            onClick={() => {
              setEditingId(null);
              setNewCred({ name: '', registry: '', username: '', password: '', type: 'dockerhub' });
              setIsAdding(true);
            }}
            className="btn-primary flex items-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>[ Add_New_Key ]</span>
          </button>
        )}
      </div>

      {isAdding && (
        <div className="bg-panel border border-primary/30 p-6 relative animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-primary"></div>
          <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-primary"></div>
          <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-primary"></div>
          <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-primary"></div>
          
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-sm font-bold text-primary uppercase tracking-widest">
              {editingId ? `Edit_Key: ${editingId}` : 'New_Key_Configuration'}
            </h3>
          </div>

          <form onSubmit={handleAdd} className="grid grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="form-group-geek">
                <label className="text-[10px] text-textMain/40 block mb-1">REGISTRY_TYPE</label>
                <select 
                  value={newCred.type}
                  onChange={e => handleTypeChange(e.target.value)}
                  className="w-full"
                >
                  {registryTemplates.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="form-group-geek">
                <label className="text-[10px] text-textMain/40 block mb-1">KEY_NAME</label>
                <input 
                  required
                  value={newCred.name}
                  onChange={e => setNewCred({...newCred, name: e.target.value})}
                  className="w-full" 
                  placeholder="e.g. DockerHub-Prod" 
                />
              </div>
            </div>
            <div className="space-y-4">
              <div className="form-group-geek">
                <label className="text-[10px] text-textMain/40 block mb-1">REGISTRY_URL</label>
                <input 
                  required
                  value={newCred.registry}
                  onChange={e => setNewCred({...newCred, registry: e.target.value})}
                  className="w-full" 
                  placeholder="e.g. index.docker.io" 
                />
              </div>
              <div className="form-group-geek">
                <label className="text-[10px] text-textMain/40 block mb-1">IDENTITY_USERNAME</label>
                <input 
                  required
                  value={newCred.username}
                  onChange={e => setNewCred({...newCred, username: e.target.value})}
                  className="w-full" 
                  placeholder="Username / Email" 
                />
              </div>
            </div>
            <div className="col-span-2 space-y-4">
              <div className="form-group-geek">
                <label className="text-[10px] text-textMain/40 block mb-1">SECRET_ACCESS_TOKEN</label>
                <input 
                  required={!editingId}
                  type="password"
                  value={newCred.password}
                  onChange={e => setNewCred({...newCred, password: e.target.value})}
                  className="w-full" 
                  placeholder={editingId ? "******** (Leave empty to keep current)" : "Password / Token"}
                />
              </div>
            </div>
            <div className="col-span-2 flex justify-end space-x-4 pt-4">
              <button 
                type="button"
                onClick={() => {
                  setIsAdding(false);
                  setEditingId(null);
                }}
                className="btn-secondary"
              >
                CANCEL
              </button>
              <button 
                type="submit"
                className="btn-primary"
              >
                {editingId ? 'UPDATE_VAULT' : 'COMMIT_TO_VAULT'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {credentials.length === 0 ? (
          <div className="col-span-full h-40 border border-dashed border-border flex items-center justify-center text-textMain/40 text-[10px] uppercase tracking-[0.2em]">
            No_Credentials_Found_In_Vault
          </div>
        ) : (
          credentials.map(cred => (
            <div key={cred.id} className="bg-panel border border-border p-4 hover:border-primary/50 transition-all group relative">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Key className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-textMain uppercase">{cred.name}</h3>
                    <span className="text-[8px] text-dim font-mono">{cred.id}</span>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  {!isAdding && (
                    <button 
                      onClick={() => handleEdit(cred)}
                      className="text-textMain/40 hover:text-primary transition p-1"
                      title="Edit Key"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  
                  {confirmDeleteId === cred.id ? (
                    <div className="flex items-center space-x-1 animate-in fade-in zoom-in duration-200">
                      <button 
                        onClick={() => handleDelete(cred.id)}
                        className="text-[9px] bg-red-500/20 text-red-500 hover:bg-red-500 hover:text-white px-2 py-0.5 border border-red-500/50 transition-colors uppercase font-bold"
                        disabled={deletingId === cred.id}
                      >
                        {deletingId === cred.id ? '...' : 'SURE?'}
                      </button>
                      <button 
                        onClick={() => setConfirmDeleteId(null)}
                        className="text-[9px] text-textMain/40 hover:text-textMain px-1 uppercase"
                        disabled={deletingId === cred.id}
                      >
                        NO
                      </button>
                    </div>
                  ) : (
                    <button 
                      onClick={() => setConfirmDeleteId(cred.id)}
                      className="text-textMain/40 hover:text-red-500 transition p-1"
                      title="Delete Key"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              
              <div className="space-y-2">
                <div className="flex items-center text-[9px]">
                  <Globe className="w-3 h-3 mr-2 text-textMain/40" />
                  <span className="text-textMain/60 w-16 uppercase">Registry:</span>
                  <span className="text-textMain truncate">{cred.registry}</span>
                </div>
                <div className="flex items-center text-[9px]">
                  <User className="w-3 h-3 mr-2 text-textMain/40" />
                  <span className="text-textMain/60 w-16 uppercase">Identity:</span>
                  <span className="text-textMain">{cred.username}</span>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-border flex justify-between items-center">
                <div className="flex items-center space-x-2">
                  <span className="text-[8px] text-dim uppercase">Status:</span>
                  {verificationStatus[cred.id] === 'idle' ? (
                    <Loader2 className="w-3 h-3 text-primary animate-spin" />
                  ) : (
                    <div className="flex items-center space-x-2">
                      {verificationStatus[cred.id] === 'success' ? (
                        <div className="flex items-center text-primary text-[8px] uppercase">
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Verified
                        </div>
                      ) : verificationStatus[cred.id] === 'error' ? (
                        <div className="flex items-center text-red-500 text-[8px] uppercase">
                          <XCircle className="w-3 h-3 mr-1" /> Error
                        </div>
                      ) : null}
                      
                      <button 
                        onClick={() => verifyCredential(cred.id)}
                        className={`text-[8px] uppercase flex items-center transition-colors ${
                          verificationStatus[cred.id] 
                            ? 'text-textMain/40 hover:text-primary' 
                            : 'text-textMain/40 hover:text-primary underline'
                        }`}
                        title={verificationStatus[cred.id] ? "Retry Verification" : "Verify Now"}
                        disabled={verificationStatus[cred.id] === 'idle'}
                      >
                        {verificationStatus[cred.id] === 'success' || verificationStatus[cred.id] === 'error' ? (
                          <RefreshCw className="w-2.5 h-2.5 mr-1" />
                        ) : null}
                        {verificationStatus[cred.id] === 'success' || verificationStatus[cred.id] === 'error' ? 'Retry' : 'Verify_Now'}
                      </button>
                    </div>
                  )}
                </div>
                <span className="text-[8px] text-textMain/40">TYPE: {cred.type.toUpperCase()}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default Vault;
