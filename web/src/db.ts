// the connection to the agent. it broadcasts on this machine (agent/broadcast):
// everything it has when the app connects, then what each batch changed. this
// keeps a copy, lets rows go by the same rules the agent does, and hands the
// rest of the app only what the window it's watching covers

// the rows, as agent/broadcast/store.go sends them. times are µs since the epoch,
// as bigints, like ids
export type Machine = {
    id: number; name: string; iface: string; homeLat: number; homeLon: number; homePlace: string;
    lastSeenUs: bigint; pps: number; dropped: bigint; nstat: boolean; geo: boolean; sampled: number; lastBatchUs: bigint;
};
export type Watch = {machineId: number; fromUs: bigint; toUs: bigint; overviewFromUs: bigint};
export type Conn = {
    key: string; machineId: number; connId: bigint; pid: number; process: string; proto: number; remoteIp: string;
    remotePort: number; localPort: number; host: string; firstUs: bigint; lastUs: bigint; bytesUp: number; bytesDown: number;
    pktsUp: number; pktsDown: number; rttMs: number; open: boolean; plaintext: boolean; system: boolean;
};
export type Endpoint = {
    key: string; machineId: number; ip: string; kind: string; host: string; ptr: string; lat: number; lon: number;
    located: boolean; city: string; region: string; country: string; countryCode: string; asn: number; org: string;
    owner: string; categories: string[]; tracker: boolean; rttMs: number; possible: boolean; drawnLat: number;
    drawnLon: number; route: string; lastUs: bigint;
};
export type Route = {key: string; machineId: number; prefix: string; dst: string; tracedUs: bigint; hops: string};
export type PacketChunk = {id: bigint; machineId: number; connId: bigint; t0Us: bigint; n: number; weight: number; data: string};
export type Rollup = {key: string; machineId: number; connId: bigint; minuteUs: bigint; bytesUp: number; bytesDown: number; pkts: number; pktsUp: number};
export type Traffic = {key: string; machineId: number; minuteUs: bigint; bytesUp: number; bytesDown: number; pkts: number};
export type ProcUsage = {key: string; machineId: number; pid: number; process: string; minuteUs: bigint; cpuMs: number; memBytes: number; diskBytes: number};
export type ProcRow = {key: string; machineId: number; pid: number; process: string; startUs: bigint; lastUs: bigint};

export type Status = {state: 'connecting' | 'connected' | 'offline' | 'error'; message?: string};

// what the rest of the app reads from - the agent, or the demo's recording
export interface Source {
    status: Status;
    ready: boolean;
    onChange(fn: () => void): () => void;
    machines(): Machine[];
    watch(): Watch | undefined;
    conns(): Conn[];
    endpoints(): Endpoint[];
    routes(): Route[];
    chunks(): PacketChunk[];
    rollups(): Rollup[];
    traffic(): Traffic[];
    procUsage(): ProcUsage[];
    procs(): ProcRow[];
    setWatch(machineId: number, fromMs: number, toMs: number, overviewFromMs: number): Promise<void>;
}

const SECOND = 1_000_000n;
const HOUR = 3600n * SECOND;
// agent/broadcast's LiveChunksFor, HistoryFor and RoutesFor
const LIVE_CHUNKS_FOR = 30n * SECOND;
const HISTORY_FOR = 26n * HOUR;
const ROUTES_FOR = HISTORY_FOR + 6n * HOUR;

// which fields come as json numbers but are bigints here
const BIG = {
    machine: ['lastSeenUs', 'dropped', 'lastBatchUs'],
    conns: ['connId', 'firstUs', 'lastUs'],
    endpoints: ['lastUs'],
    routes: ['tracedUs'],
    chunks: ['id', 'connId', 't0Us'],
    rollups: ['connId', 'minuteUs'],
    traffic: ['minuteUs'],
    procUsage: ['minuteUs'],
    procs: ['startUs', 'lastUs'],
} as const;

function big<T>(row: any, fields: readonly string[]): T {
    for (const f of fields) row[f] = BigInt(Math.max(0, Math.trunc(Number(row[f]) || 0)));
    return row;
}

const nowUs = () => BigInt(Date.now()) * 1000n;

export class AgentSource implements Source {
    status: Status = {state: 'connecting'};
    ready = false; // the first snapshot's in
    #listeners = new Set<() => void>();
    #machine?: Machine;
    #watch?: Watch;
    #conns = new Map<string, Conn>();
    #endpoints = new Map<string, Endpoint>();
    #routes = new Map<string, Route>();
    #chunks = new Map<bigint, PacketChunk>();
    #rollups = new Map<string, Rollup>();
    #traffic = new Map<string, Traffic>();
    #usage = new Map<string, ProcUsage>();
    #procs = new Map<string, ProcRow>();

    constructor(readonly url: string) {
        const events = new EventSource(`${url.replace(/\/$/, '')}/events`);
        events.addEventListener('snapshot', e => {
            this.#clear(); // the agent's (re)started, or this fell behind - start again
            this.#apply(JSON.parse((e as MessageEvent).data));
            this.ready = true;
            this.#setStatus({state: 'connected'});
        });
        events.addEventListener('update', e => {
            this.#apply(JSON.parse((e as MessageEvent).data));
            this.#changed();
        });
        events.addEventListener('error', () => {
            // it keeps trying on its own, unless it was turned away
            this.#setStatus(events.readyState === EventSource.CLOSED
                ? {state: 'error', message: `the agent at ${url} turned this app away`}
                : {state: 'offline', message: `waiting for the agent on ${url}`});
        });
    }

    #clear() {
        for (const m of [this.#conns, this.#endpoints, this.#routes, this.#chunks, this.#rollups, this.#traffic, this.#usage, this.#procs]) m.clear();
    }

    #apply(rows: any) {
        if (rows.machine) this.#machine = big<Machine>(rows.machine, BIG.machine);
        const put = <T extends {key: string}>(into: Map<string, T>, list: any[] | null, fields: readonly string[]) => {
            for (const r of list ?? []) into.set(r.key, big<T>(r, fields));
        };
        put(this.#conns, rows.conns, BIG.conns);
        put(this.#endpoints, rows.endpoints, BIG.endpoints);
        put(this.#routes, rows.routes, BIG.routes);
        put(this.#rollups, rows.rollups, BIG.rollups);
        put(this.#traffic, rows.traffic, BIG.traffic);
        put(this.#usage, rows.procUsage, BIG.procUsage);
        put(this.#procs, rows.procs, BIG.procs);
        for (const r of rows.chunks ?? []) {
            const c = big<PacketChunk>(r, BIG.chunks);
            this.#chunks.set(c.id, c);
        }
        for (const e of this.#endpoints.values()) e.categories ??= [];
        this.#prune();
    }

    // what agent/broadcast's prune does
    #prune() {
        const now = nowUs();
        const drop = <T>(rows: Map<unknown, T>, gone: (r: T) => boolean) => {
            for (const [k, r] of rows) if (gone(r)) rows.delete(k);
        };
        drop(this.#chunks, c => c.t0Us < now - LIVE_CHUNKS_FOR);
        const old = now - HISTORY_FOR;
        drop(this.#conns, c => c.lastUs < old);
        drop(this.#endpoints, e => e.lastUs < old);
        drop(this.#routes, r => r.tracedUs < now - ROUTES_FOR);
        drop(this.#rollups, r => r.minuteUs < old);
        drop(this.#traffic, t => t.minuteUs < old);
        drop(this.#usage, u => u.minuteUs < old);
        drop(this.#procs, p => p.lastUs < old);
    }

    onChange(fn: () => void): () => void {
        this.#listeners.add(fn);
        return () => this.#listeners.delete(fn);
    }

    // a burst of events is one change
    #pending = false;
    #changed() {
        if (this.#pending) return;
        this.#pending = true;
        queueMicrotask(() => {
            this.#pending = false;
            for (const fn of this.#listeners) fn();
        });
    }

    #setStatus(s: Status) {
        this.status = s;
        this.#changed();
    }

    // everything since the watch's start - the app only ever watches live
    #from = () => this.#watch?.fromUs ?? 0n;

    machines = (): Machine[] => (this.#machine ? [this.#machine] : []);
    watch = (): Watch | undefined => this.#watch;
    conns = (): Conn[] => [...this.#conns.values()].filter(c => c.lastUs >= this.#from());
    endpoints = (): Endpoint[] => [...this.#endpoints.values()].filter(e => e.lastUs >= this.#from());
    // routes are traced every few hours, so one from a little before the window still applies
    routes = (): Route[] => [...this.#routes.values()].filter(r => r.tracedUs >= this.#from() - 6n * HOUR);
    chunks = (): PacketChunk[] => [...this.#chunks.values()];
    rollups = (): Rollup[] => [...this.#rollups.values()].filter(r => r.minuteUs >= this.#from());
    traffic = (): Traffic[] => [...this.#traffic.values()].filter(t => t.minuteUs >= (this.#watch?.overviewFromUs ?? 0n));
    procUsage = (): ProcUsage[] => [...this.#usage.values()].filter(u => u.minuteUs >= this.#from());
    procs = (): ProcRow[] => [...this.#procs.values()].filter(p => p.lastUs >= this.#from());

    setWatch = async (machineId: number, fromMs: number, toMs: number, overviewFromMs: number) => {
        const us = (ms: number) => BigInt(Math.round(ms)) * 1000n;
        this.#watch = {machineId, fromUs: us(fromMs), toUs: us(toMs), overviewFromUs: us(overviewFromMs)};
        this.#changed();
    };
}

export const ms = (us: bigint) => Number(us / 1000n);
