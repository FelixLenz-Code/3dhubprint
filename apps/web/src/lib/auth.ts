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

/** True when the signed-in user may control printers. */
export function useIsAdmin() {
  const { data } = useAuth();
  return data?.state === 'authenticated' && data.user.role === 'admin';
}
