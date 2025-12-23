import axios from 'axios';

const api = axios.create();

api.interceptors.request.use((config) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isTauri = typeof window !== 'undefined' && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__);
  const baseURL = (import.meta.env.DEV || isTauri) ? 'http://127.0.0.1:7626/api' : '/api';
  config.baseURL = baseURL;
  return config;
});

export default api;
