// a stand-in for the database that plays back `upi dump -chunks` output, a batch
// every two seconds, looping - for working on the site without an agent or a
// SpacetimeDB to hand. open the site with #demo (the dump goes in
// public/demo/batches.jsonl, which is gitignored - it's somebody's real traffic)
import type {Identity} from 'spacetimedb';
import type {Conn, Endpoint, Machine, PacketChunk, ProcRow, ProcUsage, Rollup, Route, Status, Traffic, Watch} from './db';

type Batch = {
    t: number;
    stats: {iface: string; pps: number; dropped: number; nstat: boolean; geo: boolean; sampled: number};
    home?: {lat: number; lon: number; place: string};
    conns: any[];
    endpoints: any[];
    routes: any[];
    chunks: any[];
    procs?: any[]; // dumps from before the agent read process usage don't have it
};

const big = (n: number) => BigInt(Math.max(0, Math.trunc(n)));

export class DemoSource {
    status: Status = {state: 'connecting'};
    ready = false;
    identity?: Identity;
    #listeners = new Set<() => void>();
    #batches: Batch[] = [];
    #next = 0;
    #machine: Machine;
    #conns = new Map<string, Conn>();
    #endpoints = new Map<string, Endpoint>();
    #routes = new Map<string, Route>();
    #chunks = new Map<bigint, PacketChunk>();
    #traffic = new Map<string, Traffic>();
    #rollups = new Map<string, Rollup>();
    #usage = new Map<string, ProcUsage>();
    #procs = new Map<string, ProcRow>();
    #chunkId = 0n;

    constructor(url: string) {
        this.#machine = {
            id: 1, agent: undefined as unknown as Identity, name: 'demo', iface: 'en0', homeLat: 0, homeLon: 0, homePlace: '',
            lastSeenUs: 0n, pps: 0, dropped: 0n, nstat: true, geo: true, sampled: 1, lastBatchUs: 0n,
        };
        fetch(url)
            .then(r => (r.ok ? r.text() : Promise.reject(new Error(`${url}: ${r.status}`))))
            .then(text => {
                this.#batches = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
                if (!this.#batches.length) throw new Error(`${url} is empty`);
                this.status = {state: 'connected'};
                this.ready = true;
                this.#tick();
                setInterval(() => this.#tick(), 2000);
            })
            .catch(err => {
                this.status = {state: 'error', message: err.message};
                this.#changed();
            });
    }

    // the next batch, moved in time to now
    #tick() {
        const b = this.#batches[this.#next++ % this.#batches.length];
        const shift = Date.now() * 1000 - b.t;
        const us = (t: number) => big(t + shift);
        const nowUs = big(Date.now() * 1000);
        const minute = (nowUs / 60_000_000n) * 60_000_000n;
        const m = this.#machine;
        Object.assign(m, {lastSeenUs: nowUs, pps: b.stats.pps, sampled: b.stats.sampled, nstat: b.stats.nstat, geo: b.stats.geo, iface: b.stats.iface});
        if (b.home) Object.assign(m, {homeLat: b.home.lat, homeLon: b.home.lon, homePlace: b.home.place});

        for (const c of b.conns) {
            const key = `1/${c.id}`;
            this.#conns.set(key, {
                key, machineId: 1, connId: BigInt(c.id), pid: c.pid, process: c.process, proto: c.proto, remoteIp: c.remoteIp,
                remotePort: c.remotePort, localPort: c.localPort, host: c.host, firstUs: us(c.firstUs), lastUs: us(c.lastUs),
                bytesUp: c.bytesUp, bytesDown: c.bytesDown, pktsUp: c.pktsUp, pktsDown: c.pktsDown, rttMs: c.rttMs,
                open: c.open, plaintext: c.plaintext, system: c.system,
            });
            const tk = `1/${minute}`;
            const tr = this.#traffic.get(tk) ?? {key: tk, machineId: 1, minuteUs: minute, bytesUp: 0, bytesDown: 0, pkts: 0};
            this.#traffic.set(tk, {...tr, bytesUp: tr.bytesUp + c.dUp, bytesDown: tr.bytesDown + c.dDown, pkts: tr.pkts + c.dPkts});
            const rk = `${key}/${minute}`;
            const r = this.#rollups.get(rk) ?? {key: rk, machineId: 1, connId: BigInt(c.id), minuteUs: minute, bytesUp: 0, bytesDown: 0, pkts: 0, pktsUp: 0};
            this.#rollups.set(rk, {...r, bytesUp: r.bytesUp + c.dUp, bytesDown: r.bytesDown + c.dDown, pkts: r.pkts + c.dPkts, pktsUp: r.pktsUp + (c.dPktsUp ?? 0)});
        }
        for (const p of b.procs ?? []) {
            if (p.startUs) this.#procs.set(`1/${p.pid}`, {key: `1/${p.pid}`, machineId: 1, pid: p.pid, process: p.process, startUs: us(p.startUs), lastUs: nowUs});
            if (p.measured === false) continue;
            const key = `1/${p.pid}/${minute}`;
            const u = this.#usage.get(key) ?? {key, machineId: 1, pid: p.pid, process: p.process, minuteUs: minute, cpuMs: 0, memBytes: 0, diskBytes: 0};
            this.#usage.set(key, {...u, cpuMs: u.cpuMs + p.cpuMs, memBytes: Math.max(u.memBytes, p.mem), diskBytes: u.diskBytes + p.disk});
        }
        for (const e of b.endpoints) {
            const key = `1/${e.ip}`;
            this.#endpoints.set(key, {...e, key, machineId: 1, categories: e.categories ?? [], lastUs: nowUs});
        }
        for (const r of b.routes) {
            const key = `1/${r.prefix}`;
            this.#routes.set(key, {key, machineId: 1, prefix: r.prefix, dst: r.dst, tracedUs: us(r.tracedUs), hops: JSON.stringify(r.hops)});
        }
        for (const c of b.chunks) {
            if (!c.data) continue; // dumped without -chunks
            const id = ++this.#chunkId;
            this.#chunks.set(id, {id, machineId: 1, connId: BigInt(c.conn), t0Us: us(c.t0), n: c.n, weight: c.w, data: c.data});
        }
        // the live view only keeps the last 30 seconds of packets, like the module
        for (const [id, c] of this.#chunks) if (c.t0Us < nowUs - 30_000_000n) this.#chunks.delete(id);
        // and a conn shows while it's been active in the last 15 minutes
        for (const [k, c] of this.#conns) if (c.lastUs < nowUs - 900_000_000n) this.#conns.delete(k);
        for (const rows of [this.#rollups, this.#usage]) for (const [k, r] of rows) if (r.minuteUs < nowUs - 900_000_000n) rows.delete(k);
        this.#changed();
    }

    onChange(fn: () => void): () => void {
        this.#listeners.add(fn);
        return () => this.#listeners.delete(fn);
    }

    #changed() {
        for (const fn of this.#listeners) fn();
    }

    machines = (): Machine[] => [this.#machine];
    watch = (): Watch => ({identity: undefined as unknown as Identity, machineId: 1, fromUs: 0n, toUs: 0n, overviewFromUs: 0n});
    conns = () => [...this.#conns.values()];
    endpoints = () => [...this.#endpoints.values()];
    routes = () => [...this.#routes.values()];
    chunks = () => [...this.#chunks.values()];
    rollups = () => [...this.#rollups.values()];
    traffic = () => [...this.#traffic.values()];
    procUsage = () => [...this.#usage.values()];
    procs = () => [...this.#procs.values()];

    // nothing to pair with or replay - the demo's always live
    claim = async (_code: string) => {};
    forget = async (_machineId: number) => {};
    setWatch = async (_machineId: number, _fromMs: number, _toMs: number, _overviewFromMs: number) => {};
}
