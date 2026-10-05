import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for secrets at rest (printer API keys, TOTP secrets).
 * Format: v1:<iv b64>:<tag b64>:<ciphertext b64>
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(appSecret: string) {
    this.key = createHash('sha256').update(`printhub-secretbox:${appSecret}`).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
  }

  decrypt(box: string): string {
    const [v, iv, tag, ct] = box.split(':');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
