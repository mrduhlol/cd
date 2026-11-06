import { DurableObject } from 'cloudflare:workers';
import { boundedPushJSON } from './device-push';

type Phone = { id: string; name: string; publicKey: string };
type PairRequest = { id: string; target: string; envelope: string; expiresAt: number };

export class AccountRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
    if (request.method === 'GET') {
      const phones = await this.ctx.storage.list<Phone>({ prefix: 'phone:', limit: 32 });
      const pairs = await this.ctx.storage.list<PairRequest>({ prefix: 'pair:', limit: 64 });
      return reply({ phones: [...phones.values()], pairs: [...pairs.values()].filter(p => p.expiresAt > Date.now()) });
    }
    let data: unknown;
    try { data = await boundedPushJSON(request, 20000); } catch { return reply({ error: 'invalid or oversized JSON' }, 400); }
    if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(data.id)) return reply({ error: 'invalid device ID' }, 400);
    if (url.pathname.endsWith('/phone') && request.method === 'POST' && 'name' in data && typeof data.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.name) && 'publicKey' in data && typeof data.publicKey === 'string' && /^[A-Za-z0-9_-]{80,256}$/.test(data.publicKey)) {
      const phones = await this.ctx.storage.list<Phone>({ prefix: 'phone:', limit: 33 });
      if (phones.size >= 32 && !phones.has(`phone:${data.id}`)) return reply({ error: 'device limit' }, 409);
      if ([...phones.values()].some(p => p.name === data.name && p.id !== data.id)) return reply({ error: 'device name already registered' }, 409);
      await this.ctx.storage.put(`phone:${data.id}`, { id: data.id, name: data.name, publicKey: data.publicKey });
      return reply({ ok: true });
    }
    if (url.pathname.endsWith('/pair') && request.method === 'POST' && 'target' in data && typeof data.target === 'string' && 'envelope' in data && typeof data.envelope === 'string' && /^[A-Za-z0-9_-]{32,16384}$/.test(data.envelope)) {
      if (!await this.ctx.storage.get(`phone:${data.target}`)) return reply({ error: 'unknown device' }, 404);
      const pending = await this.ctx.storage.list<PairRequest>({ prefix: 'pair:', limit: 65 });
      for (const [key, pair] of pending) if (pair.expiresAt <= Date.now()) await this.ctx.storage.delete(key);
      if ([...pending.values()].filter(p => p.expiresAt > Date.now()).length >= 64) return reply({ error: 'pairing limit' }, 429);
      await this.ctx.storage.put(`pair:${data.id}`, { id: data.id, target: data.target, envelope: data.envelope, expiresAt: Date.now() + 300000 });
      await this.ctx.storage.setAlarm(Date.now() + 300000);
      return reply({ ok: true });
    }
    if (url.pathname.endsWith('/pair') && request.method === 'DELETE') {
      await this.ctx.storage.delete(`pair:${data.id}`);
      return reply({ ok: true });
    }
    if (url.pathname.endsWith('/phone') && request.method === 'DELETE') {
      await this.ctx.storage.delete(`phone:${data.id}`);
      return reply({ ok: true });
    }
    return reply({ error: 'invalid request' }, 400);
  }
  async alarm(): Promise<void> {
    const pending = await this.ctx.storage.list<PairRequest>({ prefix: 'pair:', limit: 64 });
    for (const [key, pair] of pending) if (pair.expiresAt <= Date.now()) await this.ctx.storage.delete(key);
    if ([...pending.values()].some(p => p.expiresAt > Date.now())) await this.ctx.storage.setAlarm(Date.now() + 300000);
  }
}
