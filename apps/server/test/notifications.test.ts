import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { openDb } from '../src/db/index.js';
import { SecretBox } from '../src/crypto.js';
import { NotificationService } from '../src/notifications/service.js';
import type { PrinterManager } from '../src/printers/manager.js';
import type { SlicingService } from '../src/slicer/service.js';
import type { JobInfo } from '@printhub/shared';
import { users } from '../src/db/schema.js';

function setup() {
  const { db } = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'printhub-push-')));
  const push = new NotificationService(db, new SecretBox('k'.repeat(32)), pino({ level: 'silent' }), 'mailto:test@example.org');
  const send = vi.spyOn(push, 'send').mockResolvedValue(1);
  const manager = Object.assign(new EventEmitter(), { name: (id: number) => `Drucker ${id}` }) as unknown as PrinterManager;
  const slicing = Object.assign(new EventEmitter(), { waitingCount: () => 2 }) as unknown as SlicingService;
  push.attach(manager, slicing);
  return { db, push, send, manager, slicing };
}

describe('NotificationService', () => {
  it('creates VAPID keys once and keeps them', () => {
    const { db, push } = setup();
    const again = new NotificationService(db, new SecretBox('k'.repeat(32)), pino({ level: 'silent' }), 'mailto:x@example.org');
    expect(again.publicKey).toBe(push.publicKey);
    expect(push.publicKey.length).toBeGreaterThan(80);
  });

  it('survives a changed APP_SECRET by creating new keys and dropping old subscriptions', () => {
    const { db, push } = setup();
    db.insert(users).values({ username: 'u', passwordHash: 'x', createdAt: 0 }).run();
    push.subscribe(1, { endpoint: 'https://push.example.org/a', keys: { p256dh: 'p', auth: 'a' } }, ['print_done'], null);
    const other = new NotificationService(db, new SecretBox('anderes-secret'.repeat(3)), pino({ level: 'silent' }), 'mailto:x@example.org');
    expect(other.publicKey).not.toBe(push.publicKey);
    expect(other.devices(1)).toEqual([]);
  });

  it('turns print events into the right notifications', () => {
    const { send, manager } = setup();
    manager.emit('print', { type: 'finished', printerId: 1, filename: 'sub/halter.gcode', result: 'complete', duration: 3720 });
    manager.emit('print', { type: 'finished', printerId: 1, filename: 'halter.gcode', result: 'error', message: 'Heater not heating' });
    manager.emit('print', { type: 'paused', printerId: 1, filename: 'halter.gcode', message: 'Filament runout' });
    manager.emit('print', { type: 'started', printerId: 1 });
    manager.emit('print', { type: 'idle', printerId: 1 });
    expect(send.mock.calls.map((c) => c[0])).toEqual(['print_done', 'print_error', 'print_paused']);
    expect(send.mock.calls[0]![1]).toMatchObject({
      title: '✅ Drucker 1: Druck fertig',
      body: 'halter (1 h 2 min). Bett räumen und bestätigen, dann startet der nächste (2 in der Warteschlange).',
      url: '/printers/1',
    });
    expect(send.mock.calls[1]![1].body).toBe('halter: Heater not heating');
  });

  it('notifies about failed slices only on the transition', () => {
    const { send, slicing } = setup();
    const job = { id: 7, status: 'slicing', models: [{ name: 'Vase' }], printer: { name: 'K1' }, error: null } as unknown as JobInfo;
    slicing.emit('job', job);
    slicing.emit('job', { ...job, status: 'slicing' });
    slicing.emit('job', { ...job, status: 'failed', error: 'zu groß' });
    slicing.emit('job', { ...job, status: 'failed', error: 'zu groß' });
    expect(send.mock.calls.map((c) => c[0])).toEqual(['slice_failed']);
    expect(send.mock.calls[0]![1].body).toBe('Vase: zu groß');
  });

  it('stores subscriptions per device and filters by event', () => {
    const { push, db } = setup();
    db.insert(users).values({ username: 'u', passwordHash: 'x', createdAt: 0 }).run();
    push.subscribe(1, { endpoint: 'https://push.example.org/a', keys: { p256dh: 'p', auth: 'a' } }, ['print_done'], 'Firefox');
    push.subscribe(1, { endpoint: 'https://push.example.org/a', keys: { p256dh: 'p', auth: 'a' } }, ['print_done', 'print_error'], 'Firefox');
    expect(push.devices(1)).toHaveLength(1);
    expect(push.devices(1)[0]!.events).toEqual(['print_done', 'print_error']);
    expect(push.updateEvents(2, 'https://push.example.org/a', [])).toBe(false); // other user
  });
});
