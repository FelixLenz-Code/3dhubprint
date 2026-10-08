import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(12, 'Mindestens 12 Zeichen')
  .max(256, 'Höchstens 256 Zeichen');

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Nur Buchstaben, Ziffern, . _ -');

export const setupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  /** TOTP code or recovery code, required when 2FA is enabled. */
  code: z.string().trim().max(32).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const totpConfirmSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, '6-stelliger Code'),
});

export const totpDisableSchema = z.object({
  password: z.string().min(1).max(256),
  code: z.string().trim().min(6).max(32),
});

export type Role = 'admin' | 'viewer';

export interface Me {
  id: number;
  username: string;
  role: Role;
  totpEnabled: boolean;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export type AuthState =
  /** fromLan: the first account can only be created from the local network. */
  | { state: 'setup_required'; fromLan: boolean }
  | { state: 'anonymous' }
  | { state: 'authenticated'; user: Me };
