import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthState } from '@printhub/shared';
import { api } from './api';

export const authKey = ['auth', 'state'] as const;

export function useAuth() {
  return useQuery({ queryKey: authKey, queryFn: () => api<AuthState>('/auth/state'), staleTime: Infinity });
}

export function useRefreshAuth() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: authKey });
}
