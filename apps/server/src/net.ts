import net from 'node:net';
import type { FastifyRequest } from 'fastify';

const PRIVATE_V4: [number, number][] = [
  [0x0a000000, 8], // 10.0.0.0/8
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
];

/** Loopback, private (RFC 1918 / ULA) and link-local addresses. */
export function isPrivateIp(ip: string): boolean {
  let addr = ip.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) addr = mapped[1]!;
  if (net.isIPv4(addr)) {
    const n = addr.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
    return PRIVATE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  }
  if (net.isIPv6(addr)) {
    const a = addr.toLowerCase();
    return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
  }
  return false;
}

/**
 * True when the request comes from the local network: the connection itself and every address a
 * proxy put into X-Forwarded-For are private. That also holds for a reverse proxy that isn't
 * listed in TRUSTED_PROXIES, which would otherwise make outside visitors look local.
 */
export function fromLocalNetwork(req: FastifyRequest): boolean {
  const peer = req.socket.remoteAddress;
  if (!peer || !isPrivateIp(peer) || !isPrivateIp(req.ip)) return false;
  const forwarded = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) hops.push(realIp.trim());
  return hops.every(isPrivateIp);
}
