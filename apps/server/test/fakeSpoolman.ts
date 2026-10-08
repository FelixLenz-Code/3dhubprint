import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Spoolman stand-in: info, spool list/detail and the "use" endpoint (recorded). */
export class FakeSpoolman {
  spools: Record<string, unknown>[] = [
    {
      id: 1,
      filament: { id: 1, name: 'PLA Basic', vendor: { name: 'Bambu' }, material: 'PLA', price: 20, weight: 1000, density: 1.24, diameter: 1.75, color_hex: 'ff8800' },
      price: 30,
      initial_weight: 1000,
      remaining_weight: 820,
      used_weight: 180,
      location: 'Regal',
      last_used: '2026-10-01T10:00:00',
      archived: false,
    },
    {
      id: 2,
      filament: { id: 2, name: 'PETG Schwarz', vendor: null, material: 'PETG', price: 25, weight: 1000, color_hex: '111111' },
      remaining_weight: 40,
      used_weight: 960,
      archived: false,
    },
  ];
  uses: { id: number; body: Record<string, number> }[] = [];
  vendors: Record<string, unknown>[] = [{ id: 1, name: 'Bambu' }];
  filaments: Record<string, unknown>[] = [];
  private server = http.createServer((req, res) => this.onHttp(req, res));

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise((r) => this.server.close(r));
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const [url = '', query = ''] = (req.url ?? '').split('?');
      if (url === '/api/v1/info') return json(200, { version: '0.22.1' });
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (url === '/api/v1/spool' && req.method === 'POST') {
        const filament = this.filaments.find((f) => f.id === body.filament_id);
        if (!filament) return json(404, { message: 'filament not found' });
        if (body.used_weight !== undefined && body.remaining_weight !== undefined) return json(400, { message: 'Only specify either remaining_weight or used_weight.' });
        const weight = body.initial_weight ?? filament.weight;
        const used = body.used_weight ?? 0;
        const spool = { id: Math.max(0, ...this.spools.map((x) => Number(x.id))) + 1, ...body, filament, initial_weight: weight, remaining_weight: weight - used, used_weight: used, archived: false };
        this.spools.push(spool);
        return json(200, spool);
      }
      if (url === '/api/v1/spool') return json(200, this.spools.filter((s) => !s.archived || query.includes('allow_archived=true')));
      if (url === '/api/v1/vendor' && req.method === 'POST') {
        const v = { id: this.vendors.length + 1, name: body.name };
        this.vendors.push(v);
        return json(200, v);
      }
      if (url === '/api/v1/vendor') return json(200, this.vendors);
      if (url === '/api/v1/filament' && req.method === 'POST') {
        if (!(body.density > 0)) return json(422, { message: 'density required' });
        const f = { id: this.filaments.length + 1, ...body, vendor: this.vendors.find((v) => v.id === body.vendor_id) };
        this.filaments.push(f);
        return json(200, f);
      }
      if (url === '/api/v1/filament') return json(200, this.filaments);
      const fil = /^\/api\/v1\/filament\/(\d+)$/.exec(url);
      if (fil) {
        const f = this.filaments.find((x) => x.id === Number(fil[1]));
        if (!f) return json(404, { message: 'not found' });
        if (req.method === 'DELETE') {
          if (this.spools.some((sp) => (sp.filament as { id: number }).id === f.id)) return json(403, { message: 'Failed to delete filament' });
          this.filaments = this.filaments.filter((x) => x !== f);
          return json(200, { message: 'Success!' });
        }
        if (req.method === 'PATCH') Object.assign(f, body, { vendor: this.vendors.find((v) => v.id === body.vendor_id) ?? null });
        return json(200, f);
      }
      const patch = /^\/api\/v1\/spool\/(\d+)$/.exec(url);
      if (patch && req.method === 'PATCH') {
        const sp = this.spools.find((x) => x.id === Number(patch[1]));
        if (!sp) return json(404, { message: 'not found' });
        for (const k of ['archived', 'initial_weight', 'spool_weight', 'price', 'location', 'comment']) if (body[k] !== undefined) sp[k] = body[k];
        if (body.remaining_weight !== undefined) sp.used_weight = Number(sp.initial_weight) - body.remaining_weight;
        if (body.used_weight !== undefined) sp.used_weight = body.used_weight;
        sp.remaining_weight = Number(sp.initial_weight) - Number(sp.used_weight);
        return json(200, sp);
      }
      if (patch && req.method === 'DELETE') {
        const before = this.spools.length;
        this.spools = this.spools.filter((x) => x.id !== Number(patch[1]));
        return before === this.spools.length ? json(404, { message: 'not found' }) : json(200, { message: 'Success!' });
      }
      const use = /^\/api\/v1\/spool\/(\d+)\/use$/.exec(url);
      if (use && req.method === 'PUT') {
        this.uses.push({ id: Number(use[1]), body });
        return json(200, this.spools.find((s) => s.id === Number(use[1])));
      }
      const one = /^\/api\/v1\/spool\/(\d+)$/.exec(url);
      const spool = one && this.spools.find((s) => s.id === Number(one[1]));
      if (spool) return json(200, spool);
      return json(404, { message: 'not found' });
    });
  }
}
