import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';

authenticator.options = { window: 1, step: 30, digits: 6 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret(20);
}

/**
 * Returns the accepted time step, or null if the code is invalid.
 * Callers must reject steps <= the last accepted step to prevent replay.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null) return null;
  return Math.floor(now / 1000 / 30) + delta;
}

export async function totpProvisioning(secret: string, username: string, issuer: string) {
  const uri = authenticator.keyuri(username, issuer, secret);
  const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  return { uri, qrDataUrl, secret };
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 10 codes like "k7m2-x9qa-3hpt" (~73 bits each). */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(12);
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');
}
