import { useState, useEffect } from 'react';
import { Command } from '@tauri-apps/plugin-shell';
import { appDataDir } from '@tauri-apps/api/path';
import { Navbar } from './components/Navbar';
import Vault from './components/Vault';
import Designer from './components/Designer';
import HistoryView from './components/History';
import { ImageArchiveLoader } from './components/ImageArchiveLoader';
import { Dashboard } from './components/Dashboard';
import { Config } from './components/Config';
import { useTheme } from './hooks/useTheme';



declare const __APP_VERSION__: string;

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isImageLoaderOpen, setIsImageLoaderOpen] = useState(false);
  const [isBackendReady, setIsBackendReady] = useState(false);
  const [initStatus, setInitStatus] = useState('Initializing...');
  const [initError, setInitError] = useState<string | null>(null);
  const { theme, setTheme } = useTheme();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isTauriRuntime = () => typeof window !== 'undefined' && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__);

  useEffect(() => {
    const initSidecar = async () => {
      try {
        setInitStatus('Checking existing backend...');
        // 1. Check if backend is already running
        try {
          const response = await fetch('http://127.0.0.1:7626/api/health');
          if (response.ok) {
            console.log('Sidecar backend is already running');
            setIsBackendReady(true);
            return;
          }
        } catch {
          // Ignore connection error, backend not running
        }

        const isTauri = isTauriRuntime();
        if (isTauri) {
          setInitStatus('Starting Sidecar...');
          // 2. Start Sidecar
          try {
            const dataDir = await appDataDir();
            console.log('App Data Dir:', dataDir);
            const command = Command.sidecar('horcrux-backend', ['serve', '--port', '7626', '--data-dir', dataDir]);
            console.log('[DEBUG] Created sidecar command:', command);

            command.on('close', data => {
              console.log(`Sidecar finished with code ${data.code} and signal ${data.signal}`);
              if (data.code !== 0) {
                setInitError(`Sidecar crashed! Code: ${data.code}. See console for logs.`);
              }
            });
            command.on('error', error => {
              console.error(`Sidecar error: "${error}"`);
              setInitError(`Sidecar error: ${error}`);
            });
            command.stdout.on('data', line => console.log(`[SIDECAR] ${line}`));
            command.stderr.on('data', line => console.error(`[SIDECAR ERR] ${line}`));

            const child = await command.spawn();
            console.log('Sidecar spawned:', child.pid);
          } catch (spawnError) {
            console.error('Failed to spawn sidecar:', spawnError);
            setInitError(`Failed to spawn sidecar: ${spawnError}`);
            // Continue to try polling, in case it started anyway or is managed externally
          }
        } else {
          console.log('Not in Tauri, skipping sidecar spawn');
          setInitStatus('Waiting for backend readiness...');
        }

        setInitStatus('Waiting for backend readiness...');
        // 3. Poll for backend readiness
        let attempts = 0;
        const maxAttempts = 30; // 30 seconds timeout
        const pollInterval = setInterval(async () => {
          attempts++;
          setInitStatus(`Waiting for backend... (${attempts}/${maxAttempts})`);
          try {
            const response = await fetch('http://127.0.0.1:7626/api/health');
            if (response.ok) {
              clearInterval(pollInterval);
              setIsBackendReady(true);
              console.log('Backend is ready!');
            }
          } catch {
            if (attempts >= maxAttempts) {
              clearInterval(pollInterval);
              console.error('Backend failed to start within timeout');
              setInitError('Backend failed to start within 30s timeout. Please check logs.');
            }
          }
        }, 1000);

      } catch (e) {
        console.error('Initialization error:', e);
        setInitError(`Initialization error: ${e}`);
      }
    };
    initSidecar();
  }, []);

  if (!isBackendReady) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-background text-primary font-mono space-y-4">
        <div className="w-12 h-12 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
        <div className="text-sm tracking-widest animate-pulse">INITIALIZING SYSTEM...</div>
        <div className="text-xs text-textMain/40">{initStatus}</div>
        {initError && (
          <div className="mt-4 p-4 border border-red-500 bg-red-500/10 text-red-500 text-xs max-w-lg break-all">
            ERROR: {initError}
          </div>
        )}
      </div>
    );
  }



  return (
    <div className="h-screen flex flex-col overflow-hidden relative bg-background text-textMain font-mono">
      <div className="scanline pointer-events-none"></div>

      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onOpenImageLoader={() => setIsImageLoaderOpen(true)}
        appVersion={__APP_VERSION__}
      />

      {/* 主内容区域 */}
      <main className="flex-1 flex flex-col overflow-hidden bg-background">
        <ImageArchiveLoader open={isImageLoaderOpen} onOpenChange={setIsImageLoaderOpen} />
        <div className="flex-1 overflow-hidden relative">
          {activeTab === 'dashboard' && <Dashboard setActiveTab={setActiveTab} />}
          {activeTab === 'designer' && <Designer />}
          {activeTab === 'vault' && <Vault />}
          {activeTab === 'history' && <HistoryView />}
          {activeTab === 'config' && <Config theme={theme} setTheme={setTheme} />}

          {activeTab !== 'dashboard' && activeTab !== 'designer' && activeTab !== 'vault' && activeTab !== 'history' && activeTab !== 'config' && (
            <div className="flex items-center justify-center h-full text-textMain/40 uppercase tracking-[0.3em]">
              Section: {activeTab} is under development
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
