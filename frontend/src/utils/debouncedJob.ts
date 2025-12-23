export type DebouncedJob = {
  trigger: (delayMs?: number) => void;
  flush: () => void;
  cancel: () => void;
  isPending: () => boolean;
};

export function createDebouncedJob(fn: () => void): DebouncedJob {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let latestDelay = 0;

  const cancel = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
  };

  const flush = () => {
    if (!pending) return;
    cancel();
    fn();
  };

  const trigger = (delayMs = latestDelay) => {
    latestDelay = delayMs;
    pending = true;
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      pending = false;
      fn();
    }, delayMs);
  };

  const isPending = () => pending;

  return { trigger, flush, cancel, isPending };
}

export function computeExponentialBackoffMs(attempt: number, baseMs = 800, capMs = 30_000): number {
  if (attempt <= 0) return baseMs;
  const d = baseMs * Math.pow(2, attempt);
  return Math.min(capMs, Math.floor(d));
}

