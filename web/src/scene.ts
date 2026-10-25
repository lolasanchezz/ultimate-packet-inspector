// turns what's in the database into what's on screen: lines to every endpoint,
// a dot for every packet, and the numbers behind the panels
import {decodeChunk, type PacketRecord} from './chunks';
import {ms, type Conn, type Endpoint, type Machine, type PacketChunk, type Route} from './db';
import {distanceKm, maxKm, type LonLat} from './geo';
import type {Line, Scene, Trip} from './map';
import {processPalette, themeRGB, type RGB} from './theme';
import {parseHops, type Drawn, type Hop, type Router} from './paths';

// a colour per process, from colors.css (--process-1, --process-2...), picked by
// its pid - traffic no process owns gets --process-system. re-read with each
// model, so edits show up
let palette: RGB[] = [];

export function colorOf(pid: number): RGB {
    if (pid <= 0) return themeRGB('--process-system');
    if (!palette.length) palette = processPalette();
    return palette[pid % palette.length];
}

export const rgb = (c: RGB) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

// everything on the other end of one address, from this machine
export type Group = {
    key: string;
    endpoint: Endpoint;
    conns: Conn[];
    bytes: number;
    process: string; // the one that moved the most
    pid: number; // and its pid - -1 for system traffic
    processes: string[];
    lastMs: number;
    open: boolean;
    route?: Route;
    hops: Hop[];
    drawn?: Drawn; // the way there, for anything with a place - drawn or not
    line?: Line;
};

export type Owner = {
    name: string;
    bytes: number;
    tracker: boolean;
    categories: Set<string>;
    processes: Set<string>;
    countries: Set<string>;
    keys: Set<string>;
};

export type Model = {
    machine?: Machine;
    home?: LonLat;
    groups: Map<string, Group>; // by endpoint key
    nearby: Group[]; // lan, multicast, system, or nowhere believable - nothing to draw a line to
    owners: Owner[];
    scene: Scene;
};

const bytesOf = (c: Conn) => c.bytesUp + c.bytesDown;
const ACTIVE_MS = 20_000;

// where an endpoint goes on the map: where geo-ip says - unless that's further
// than its round trip lets it be (anycast, mostly), when geo-ip's ignored and it
// goes at the last believable router on its route instead - one its own round trip
// could have reached too. no route, nowhere
export function placeOf(ep: Endpoint, hops: Hop[], home?: LonLat): LonLat | undefined {
    if (ep.kind !== 'public' || !ep.located) return undefined;
    if (ep.possible) return [ep.drawnLon, ep.drawnLat];
    for (let i = hops.length - 1; i >= 0; i--) {
        const h = hops[i];
        const at: LonLat = [h.lon, h.lat];
        const reachable = !home || ep.rttMs <= 0 || distanceKm(home, at) <= maxKm(ep.rttMs);
        if (h.ip && h.located && h.possible && reachable) return at;
    }
    return undefined;
}

export function buildModel(
    machine: Machine | undefined,
    conns: Conn[],
    endpoints: Endpoint[],
    routes: Route[],
    router: Router,
    // only: the endpoints to draw lines to - the inspector's one process. all of them if it's unset.
    // drawSince: and only to the ones active since then - the stats may cover far more
    opts: {nowMs: number; selected?: string; highlighted?: Set<string>; hovered?: string; only?: Set<string>; showRoute?: boolean; drawSince?: number},
): Model {
    palette = processPalette();
    const home: LonLat | undefined = machine && (machine.homeLat !== 0 || machine.homeLon !== 0) ? [machine.homeLon, machine.homeLat] : undefined;
    const byIp = new Map(endpoints.map(e => [e.ip, e]));
    const routesByPrefix = new Map(routes.map(r => [r.prefix, r]));

    const groups = new Map<string, Group>();
    const nearby: Group[] = [];
    for (const c of conns) {
        const ep = byIp.get(c.remoteIp) ?? placeholder(c);
        let g = groups.get(ep.key);
        if (!g) {
            const route = routesByPrefix.get(ep.route);
            g = {key: ep.key, endpoint: ep, conns: [], bytes: 0, process: '', pid: 0, processes: [], lastMs: 0, open: false, route, hops: route ? parseHops(route.hops) : []};
            groups.set(ep.key, g);
        }
        g.conns.push(c);
        g.bytes += bytesOf(c);
        g.lastMs = Math.max(g.lastMs, ms(c.lastUs));
        g.open ||= c.open;
        if (!g.processes.includes(c.process)) g.processes.push(c.process);
    }
    for (const g of groups.values()) {
        const top = g.conns.reduce((a, b) => (bytesOf(b) > bytesOf(a) ? b : a));
        g.process = top.system ? 'system' : top.process || 'unknown';
        g.pid = top.system ? -1 : top.pid;
    }

    const lines: Line[] = [];
    const cablesInUse = new Set<string>();
    const maxBytes = Math.max(1, ...[...groups.values()].map(g => g.bytes));
    for (const g of groups.values()) {
        const ep = g.endpoint;
        const system = g.conns.every(c => c.system);
        const to = home && !system ? placeOf(ep, g.hops, home) : undefined;
        if (!home || !to) {
            nearby.push(g);
            continue;
        }
        // whole milliseconds, rounded up so the limit's never tighter than physics -
        // and so a round trip that wobbles doesn't redraw the line every time
        const rtt = Math.ceil(ep.rttMs);
        // for every endpoint, drawn or not - the world stats go along it
        const drawn: Drawn = (g.drawn = router.path(`${ep.key}|${g.route?.tracedUs ?? 0}|${to}|${home}|${rtt}`, home, g.hops, to, rtt));
        if (opts.only && !opts.only.has(g.key)) continue;
        if (opts.drawSince !== undefined && g.lastMs < opts.drawSince) continue;
        drawn.cables.forEach(c => cablesInUse.add(c));
        g.line = {
            key: g.key,
            to,
            drawn,
            traced: !!g.route,
            color: colorOf(g.pid),
            weight: Math.log1p(g.bytes) / Math.log1p(maxBytes),
            active: opts.nowMs - g.lastMs < ACTIVE_MS,
            tracker: ep.tracker,
            tooltip: `${ep.host || ep.ip}\n${g.processes.map(p => p || 'unknown').join(', ')}${ep.owner ? ` · ${ep.owner}` : ''}`,
        };
        lines.push(g.line);
    }
    // the busiest last, so they're drawn on top
    lines.sort((a, b) => a.weight - b.weight);
    // the rest of the map only fades for a selection that has a line to show
    const selected = lines.some(l => l.key === opts.selected) ? opts.selected : undefined;

    return {
        machine,
        home,
        groups,
        nearby: nearby.sort((a, b) => b.bytes - a.bytes),
        owners: owners(groups),
        scene: {
            home, lines, trips: [], cablesInUse,
            selected, highlighted: opts.highlighted, hovered: opts.hovered, showRoute: opts.showRoute,
            homeName: machine?.name,
            homeLive: !!machine && opts.nowMs - ms(machine.lastSeenUs) < 30_000,
        },
    };
}

// a conn whose endpoint row hasn't arrived yet
function placeholder(c: Conn): Endpoint {
    return {
        key: `${c.machineId}/${c.remoteIp}`, machineId: c.machineId, ip: c.remoteIp, kind: 'unknown', host: c.host, ptr: '',
        lat: 0, lon: 0, located: false, city: '', region: '', country: '', countryCode: '', asn: 0, org: '', owner: '',
        categories: [], tracker: false, rttMs: 0, possible: true, drawnLat: 0, drawnLon: 0, route: '', lastUs: c.lastUs,
    };
}

function owners(groups: Map<string, Group>): Owner[] {
    const out = new Map<string, Owner>();
    for (const g of groups.values()) {
        const ep = g.endpoint;
        if (ep.kind !== 'public') continue;
        const name = ep.owner || ep.org || 'unknown';
        let o = out.get(name);
        if (!o) {
            o = {name, bytes: 0, tracker: false, categories: new Set(), processes: new Set(), countries: new Set(), keys: new Set()};
            out.set(name, o);
        }
        o.bytes += g.bytes;
        o.tracker ||= ep.tracker;
        ep.categories.forEach(c => o.categories.add(c));
        g.processes.forEach(p => o.processes.add(p || 'unknown'));
        if (ep.countryCode && ep.possible) o.countries.add(ep.countryCode);
        o.keys.add(g.key);
    }
    return [...out.values()].sort((a, b) => b.bytes - a.bytes);
}

// --- packets ---

const decoded = new Map<bigint, PacketRecord[]>();

export function records(chunk: PacketChunk): PacketRecord[] {
    let r = decoded.get(chunk.id);
    if (!r) {
        r = decodeChunk(Number(chunk.t0Us), chunk.data);
        decoded.set(chunk.id, r);
    }
    return r;
}

// forget decoded chunks the views have dropped
export function forgetChunks(live: PacketChunk[]) {
    const keep = new Set(live.map(c => c.id));
    for (const id of decoded.keys()) if (!keep.has(id)) decoded.delete(id);
}

// a process's newest packets, from the live chunks, for the inspector
export type Packet = PacketRecord & {conn: Conn};

export function recentPackets(conns: Conn[], chunks: PacketChunk[], limit: number): Packet[] {
    const byId = new Map(conns.map(c => [c.connId, c]));
    const out: Packet[] = [];
    for (const ch of chunks) {
        const conn = byId.get(ch.connId);
        if (conn) for (const rec of records(ch)) out.push({...rec, conn});
    }
    return out.sort((a, b) => b.timeUs - a.timeUs).slice(0, limit);
}

const MAX_TRIPS = 3000;

// one moving dot per packet, along its connection's line - out from home for sent
// packets, in towards it for received. a trip lasts longer the further it goes
// (stretched by speed when replaying faster than real time)
export function trips(model: Model, chunks: PacketChunk[], baseMs: number, speed: number): Trip[] {
    const byConn = new Map<string, Group>();
    for (const g of model.groups.values()) for (const c of g.conns) byConn.set(c.key, g);

    const all: {rec: PacketRecord; g: Group}[] = [];
    for (const ch of chunks) {
        const g = byConn.get(`${ch.machineId}/${ch.connId}`);
        if (!g?.line) continue;
        for (const rec of records(ch)) all.push({rec, g});
    }
    const every = Math.max(1, Math.ceil(all.length / MAX_TRIPS));
    const out: Trip[] = [];
    const reversed = new Map<Drawn, {path: LonLat[]; fractions: number[]}>();
    for (let i = 0; i < all.length; i += every) {
        const {rec, g} = all[i];
        const d = g.line!.drawn;
        const start = (rec.timeUs / 1000 - baseMs) / 1000;
        const dur = (0.5 + d.km / 9000) * speed;
        let path = d.path, fractions = d.fractions;
        if (!rec.out) {
            let r = reversed.get(d);
            if (!r) {
                r = {path: [...d.path].reverse(), fractions: d.fractions.map(f => 1 - f).reverse()};
                reversed.set(d, r);
            }
            ({path, fractions} = r);
        }
        out.push({key: g.key, path, timestamps: fractions.map(f => start + f * dur), color: g.line!.color});
    }
    return out;
}
