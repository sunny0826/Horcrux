import { useState, useEffect } from 'react';
import type { Stats, LatestTask } from '../types';
import api from '../api';

export function useDashboardStats() {
  const [stats, setStats] = useState<Stats>({
    active_threads: 0,
    total_data_size: '0 GB',
    total_tasks: 0,
    auth_keys: 0,
  });
  const [latestTask, setLatestTask] = useState<LatestTask | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const statsRes = await api.get('/stats');
        const data = statsRes.data as Partial<Record<string, unknown>>;
        setStats({
          active_threads: Number(data.active_threads ?? 0),
          total_data_size: String(data.total_data_size ?? '0 GB'),
          total_tasks: Number((data.total_tasks ?? data.manifest_assets) ?? 0),
          auth_keys: Number(data.auth_keys ?? 0),
        });

        // Fetch tasks to get the latest one for the flow preview
        const tasksRes = await api.get('/tasks');
        const tasksData = tasksRes.data as unknown;
        const tasks = Array.isArray((tasksData as { tasks?: unknown }).tasks)
          ? ((tasksData as { tasks: LatestTask[] }).tasks)
          : [];
        if (tasks.length > 0) setLatestTask(tasks[0]);
      } catch (error) {
        console.error('Failed to fetch stats:', error);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  return { stats, latestTask, setLatestTask };
}
