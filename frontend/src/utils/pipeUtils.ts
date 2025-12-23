import type { PipeMeta } from '../types';

export const getPipeStatusLabel = (p: PipeMeta) => {
  const v = Number.isFinite(p.version) ? Number(p.version) : 0;
  return v > 0 ? 'SAVED' : 'DRAFT';
};

export const getPipeDisplayName = (p: PipeMeta | null | undefined) => {
  const name = p?.name?.trim();
  if (name) return name;
  const id = p?.id?.trim();
  return id ? id : 'UNNAMED_PIPE';
};
