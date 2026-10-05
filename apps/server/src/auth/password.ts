import { hash, verify } from '@node-rs/argon2';

// Library default algorithm is argon2id; OWASP parameters: m=19 MiB, t=2, p=1.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Verified against when a username does not exist so response timing doesn't reveal valid users.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('printhub-dummy-password');
  await verifyPassword(await dummyHash, password);
}
