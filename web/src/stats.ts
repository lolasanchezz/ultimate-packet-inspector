// the overview's numbers: every process (each pid its own), ranked by whichever
// stat the menu's on, with its last few minutes for the chart
import {TCP_FLAGS} from './chunks';
import {ms, type Conn, type PacketChunk, type ProcRow, type ProcUsage, type Rollup} from './db';
import {fmtBytes, fmtCount, fmtDuration, fmtGap, fmtKm, fmtKmTotal, fmtMs, fmtPct, fmtPerSecond, fmtRate} from './format';
import {distanceKm, type LonLat} from './geo';
import {placeOf, records, type Group} from './scene';

export const MINUTES = 15; // across the chart, at least - unless the period's under a minute
const MINUTE = 60_000;
// the newest packets are a couple of seconds old by the time they're here (they come a
// batch at a time). a period under a minute ends with them - unless none have come for
// longer than this, and then it carries on without them
const STALE_MS = 5000;

// the periods a stat can be worked out over. the ones under a minute are from single
// packets, which the live view has the last 30 seconds of
export const PERIODS = [
    {minutes: 0.25, label: 'last 15 s'},
    {minutes: 0.5, label: 'last 30 s'},
    {minutes: 1, label: 'last min'},
    {minutes: 5, label: 'last 5 min'},
    {minutes: 15, label: 'last 15 min'},
    {minutes: 60, label: 'last hour'},
    {minutes: 360, label: 'last 6 hours'},
    {minutes: 1440, label: 'last 24 hours'},
];
export const periodLabel = (minutes: number) => PERIODS.find(p => p.minutes === minutes)?.label ?? `last ${minutes} min`;
// the periods a stat can go on - not under a minute if it's only known per minute
export const periodsFor = (m: Metric) => PERIODS.filter(p => p.minutes >= 1 || !m.minutesOnly);

// the chart's spread for a period: at least MINUTES, in bars of whole minutes, about
// 30 at most - an hour is 30 two-minute bars, a day 30 of 48 minutes. under a minute
// it's the last 30 seconds a second at a time, which is all the packets there are.
// there's always one bar more than that: the last is only part done, so the period
// starts part way through the first
export function binsFor(periodMinutes: number): {n: number; binMs: number} {
    if (periodMinutes < 1) return {n: 31, binMs: 1000};
    const span = Math.max(MINUTES, periodMinutes);
    const binMinutes = Math.max(1, Math.round(span / 30));
    return {n: Math.ceil(span / binMinutes) + 1, binMs: binMinutes * MINUTE};
}

// what's known about one remote address, for the world + privacy stats
export type Place = {
    km?: number; // from home, as the crow flies - unset when it can't be placed
    routeKm?: number; // along the line it's drawn on (its routers, any cables)
    country: string;
    abroad: boolean; // a different country from this machine's
    owner: string;
    asn: number; // the network it's on - 0 if that's not known
    tracker: boolean;
    ads: boolean; // there for advertising or analytics, by DuckDuckGo's categories
    named: boolean; // it has a name - a server name, a dns answer or a reverse lookup
    cables: string[];
    hops: number; // routers that answered on its traced route
    rttMs: number;
};

// what a process did over a minute - or several, merged
export type Facts = {
    up: number;
    down: number;
    pkts: number;
    pktsUp: number;
    packetKm: number; // every packet times how far it went
    cpuMs: number;
    diskBytes: number;
    memBytes: number; // the most it had
    memLatest: number; // what it had last
    memAt: number; // when that was
    measured: boolean; // the agent could read its cpu, memory + disk
    spanMs: number; // how much time these facts cover
    usageSpanMs: number; // how much of it the agent was measuring the process for
    peak: number; // its busiest minute, in bytes per second both ways
    activeMinutes: number; // minutes it sent or received anything in
    plainBytes: number; // over connections that sent readable text
    conns: Set<bigint>; // the connections that had traffic
    opened: Set<bigint>; // the connections that started
    ips: Set<string>; // where the traffic went
    bytesTo: Map<string, number>; // and how much, both ways
};

const noFacts = (): Facts => ({
    up: 0, down: 0, pkts: 0, pktsUp: 0, packetKm: 0, cpuMs: 0, diskBytes: 0, memBytes: 0, memLatest: 0, memAt: 0, measured: false,
    spanMs: 0, usageSpanMs: 0, peak: 0, activeMinutes: 0, plainBytes: 0, conns: new Set(), opened: new Set(), ips: new Set(), bytesTo: new Map(),
});

// b added to a, its counts scaled by weight - the sets and the peaks aren't
function merge(a: Facts, b: Facts, weight = 1): Facts {
    const bytesTo = new Map(a.bytesTo);
    for (const [ip, n] of b.bytesTo) bytesTo.set(ip, (bytesTo.get(ip) ?? 0) + n * weight);
    return {
        up: a.up + b.up * weight,
        down: a.down + b.down * weight,
        pkts: a.pkts + b.pkts * weight,
        pktsUp: a.pktsUp + b.pktsUp * weight,
        packetKm: a.packetKm + b.packetKm * weight,
        cpuMs: a.cpuMs + b.cpuMs * weight,
        diskBytes: a.diskBytes + b.diskBytes * weight,
        memBytes: Math.max(a.memBytes, b.memBytes),
        memLatest: b.memAt >= a.memAt ? b.memLatest : a.memLatest,
        memAt: Math.max(a.memAt, b.memAt),
        measured: a.measured || b.measured,
        spanMs: a.spanMs + b.spanMs * weight,
        usageSpanMs: a.usageSpanMs + b.usageSpanMs * weight,
        peak: Math.max(a.peak, b.peak),
        activeMinutes: a.activeMinutes + b.activeMinutes * weight,
        plainBytes: a.plainBytes + b.plainBytes * weight,
        conns: new Set([...a.conns, ...b.conns]),
        opened: new Set([...a.opened, ...b.opened]),
        ips: new Set([...a.ips, ...b.ips]),
        bytesTo,
    };
}

// one process, for the stats about a moment rather than a span of time. bins are
// the chart's bars; recent is its packets from the last 30 seconds, one by one -
// what jitter and resets come from (resets: the connections that had one)
export type ProcState = {conns: Conn[]; startMs?: number; lastMs: number; bins: Facts[]; recent: {times: number[]; resets: Set<bigint>}};

type Ctx = {places: Map<string, Place>; conns: Map<bigint, Conn>; nowMs: number; firstBinMs: number; binMs: number};

export type Metric = {
    id: string;
    group: string;
    label: string; // in the menu
    phrase?: string; // after "sorted by:", when it isn't the label
    about: string; // what it is, when the mouse is on it
    // how far back it looks: a period that can be changed (in minutes, this the one it
    // starts on) - or, for the ones that can't, a window
    period?: number;
    window?: 'last 30 s' | 'now';
    // only known a minute at a time (the agent's process readings, or a busiest
    // minute), so it can't go on a period under one
    minutesOnly?: boolean;
    format: (n: number) => string;
    keywords?: string[]; // what else someone might search for it by
    lowFirst?: boolean; // the smallest goes on top
    // the stat from what happened over some minutes - undefined when there's no way to know
    of?: (f: Facts, x: Ctx) => number | undefined;
    // or, for the ones about a moment, at that moment
    at?: (p: ProcState, atMs: number, x: Ctx) => number | undefined;
};

const placesIn = (f: Facts, x: Ctx) => [...f.ips].flatMap(ip => x.places.get(ip) ?? []);
const most = (ns: number[]) => (ns.length ? Math.max(...ns) : undefined);
const least = (ns: number[]) => (ns.length ? Math.min(...ns) : undefined);
const total = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) : undefined);
const distinct = (ss: string[]) => new Set(ss.filter(Boolean)).size;
const kms = (f: Facts, x: Ctx) => placesIn(f, x).flatMap(p => p.km ?? []);
const routeKms = (f: Facts, x: Ctx) => placesIn(f, x).flatMap(p => p.routeKm ?? []);
const measured = (f: Facts, n: number) => (f.measured ? n : undefined);
const perSecond = (n: number, spanMs: number) => (spanMs > 0 ? n / (spanMs / 1000) : undefined);
// bytes to places that pass a test
const bytesWhere = (f: Facts, x: Ctx, test: (p: Place) => boolean) => [...f.bytesTo].reduce((n, [ip, b]) => n + (test(x.places.get(ip) ?? ({} as Place)) ? b : 0), 0);
// the stats from single packets only know the last 30 seconds - so only now
const recentOnly = (at: number, x: Ctx) => at >= x.nowMs;

// how much the time from one packet to the next wanders - the standard deviation
// of the gaps, in ms
export function jitterOf(times: number[]): number | undefined {
    if (times.length < 3) return undefined;
    const t = times.slice().sort((a, b) => a - b);
    const gaps = t.slice(1).map((v, i) => v - t[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
}

export const METRICS: Metric[] = [
    // from the agent reading each process every batch - only its own user's
    {id: 'cpu', group: 'process stats', label: 'cpu usage', about: 'how much of a core it kept busy, on average - over 100% is more than one', period: 1, minutesOnly: true, format: fmtPct, keywords: ['processor', 'load', 'average'], of: f => (f.usageSpanMs > 0 ? (f.cpuMs / f.usageSpanMs) * 100 : undefined)},
    {id: 'cpu-time', group: 'process stats', label: 'cpu time', about: 'processor time it used, every core added up', period: 15, minutesOnly: true, format: fmtDuration, keywords: ['processor', 'total cpu'], of: f => measured(f, f.cpuMs)},
    {id: 'cpu-per-mb', group: 'process stats', label: 'cpu per mb', about: 'processor time it spent for every megabyte it sent or received - how hard it works for its network traffic', period: 15, minutesOnly: true, format: n => `${fmtMs(n)}/mb`, keywords: ['efficiency', 'cost', 'overhead', 'processor'], of: f => (f.measured && f.up + f.down > 0 ? f.cpuMs / ((f.up + f.down) / 1e6) : undefined)},
    {id: 'memory', group: 'process stats', label: 'memory usage', about: 'its memory the last time it was measured, counted the way activity monitor does', period: 1, minutesOnly: true, format: fmtBytes, keywords: ['ram'], of: f => measured(f, f.memLatest)},
    {id: 'peak-memory', group: 'process stats', label: 'peak memory', about: 'the most memory it had at any point', period: 15, minutesOnly: true, format: fmtBytes, keywords: ['ram', 'max memory', 'high water mark'], of: f => measured(f, f.memBytes)},
    {id: 'disk', group: 'process stats', label: 'disk usage', about: 'bytes it read from and wrote to disk', period: 1, minutesOnly: true, format: fmtBytes, keywords: ['io', 'storage', 'read', 'write'], of: f => measured(f, f.diskBytes)},
    {id: 'disk-speed', group: 'process stats', label: 'disk speed', about: 'bytes it read and wrote per second', period: 1, minutesOnly: true, format: fmtRate, keywords: ['io', 'storage', 'throughput', 'read', 'write'], of: f => perSecond(f.diskBytes, f.usageSpanMs)},

    {id: 'bandwidth', group: 'network stats', label: 'bandwidth', about: 'bytes per second, sent and received together', period: 1, format: fmtRate, keywords: ['throughput', 'speed', 'rate', 'traffic', 'bps'], of: f => perSecond(f.up + f.down, f.spanMs)},
    {id: 'peak-bandwidth', group: 'network stats', label: 'peak bandwidth', about: 'its busiest minute, in bytes per second both ways', period: 15, minutesOnly: true, format: fmtRate, keywords: ['max', 'burst', 'throughput', 'speed'], of: f => f.peak},
    {id: 'upload-speed', group: 'network stats', label: 'upload speed', about: 'bytes sent per second', period: 1, format: fmtRate, keywords: ['bandwidth', 'up', 'send rate'], of: f => perSecond(f.up, f.spanMs)},
    {id: 'upload-size', group: 'network stats', label: 'upload size', phrase: 'data uploaded', about: 'bytes sent', period: 1, format: fmtBytes, keywords: ['sent', 'up', 'data'], of: f => f.up},
    {id: 'download-speed', group: 'network stats', label: 'download speed', about: 'bytes received per second', period: 1, format: fmtRate, keywords: ['bandwidth', 'down', 'receive rate'], of: f => perSecond(f.down, f.spanMs)},
    {id: 'download-size', group: 'network stats', label: 'download size', phrase: 'data downloaded', about: 'bytes received', period: 1, format: fmtBytes, keywords: ['received', 'down', 'data'], of: f => f.down},
    {id: 'total-data', group: 'network stats', label: 'total data', about: 'bytes sent and received', period: 15, format: fmtBytes, keywords: ['traffic', 'bytes', 'volume'], of: f => f.up + f.down},
    {id: 'upload-share', group: 'network stats', label: 'upload share', about: 'how much of its traffic it was sending, rather than receiving', period: 1, format: fmtPct, keywords: ['ratio', 'upload ratio', 'sent vs received'], of: f => (f.up + f.down > 0 ? (f.up / (f.up + f.down)) * 100 : undefined)},
    {id: 'packet-rate', group: 'network stats', label: 'packet throughput', about: 'packets per second, sent and received', period: 1, format: fmtPerSecond, keywords: ['pps', 'packets per second', 'rate'], of: f => perSecond(f.pkts, f.spanMs)},
    {id: 'packets-sent', group: 'network stats', label: 'packets sent', about: 'packets that left this machine', period: 1, format: fmtCount, keywords: ['outgoing'], of: f => f.pktsUp},
    {id: 'packets-received', group: 'network stats', label: 'packets received', about: 'packets that came in', period: 1, format: fmtCount, keywords: ['incoming'], of: f => f.pkts - f.pktsUp},
    {id: 'avg-packet', group: 'network stats', label: 'average packet size', about: 'bytes per packet, both ways', period: 1, format: fmtBytes, keywords: ['mtu', 'bytes per packet'], of: f => (f.pkts > 0 ? (f.up + f.down) / f.pkts : undefined)},
    {id: 'packet-gap', group: 'network stats', label: 'time between packets', about: 'the average time from one packet to the next - the chattiest first', period: 1, format: fmtGap, lowFirst: true, keywords: ['interval', 'gap', 'spacing', 'inter-arrival', 'frequency'], of: f => (f.pkts > 0 ? f.spanMs / f.pkts : undefined)},
    {id: 'jitter', group: 'network stats', label: 'jitter', about: 'how much the time between its packets varies - a steady stream is low, bursts are high', window: 'last 30 s', format: fmtMs, keywords: ['variation', 'bursty', 'latency', 'stability'], at: (p, at, x) => (recentOnly(at, x) ? jitterOf(p.recent.times) : undefined)},
    {id: 'round-trip', group: 'network stats', label: 'round trip', about: 'the average time for an answer to come back from where it talked to', period: 1, format: fmtMs, keywords: ['latency', 'ping', 'rtt'], of: (f, x) => {
        const rtts = placesIn(f, x).flatMap(p => (p.rttMs > 0 ? [p.rttMs] : []));
        return rtts.length ? total(rtts)! / rtts.length : undefined;
    }},
    {id: 'connections', group: 'network stats', label: 'connections', about: 'connections that carried anything', period: 1, format: fmtCount, keywords: ['sockets', 'flows'], of: f => f.conns.size},
    {id: 'new-connections', group: 'network stats', label: 'new connections', about: 'connections it opened', period: 1, format: fmtCount, keywords: ['opened', 'churn', 'sockets'], of: f => f.opened.size},
    {id: 'idle-connections', group: 'network stats', label: 'idle connections', about: "connections it has open that haven't carried anything for a minute", window: 'now', format: fmtCount, keywords: ['open', 'waiting', 'keepalive', 'sockets'], at: (p, at, x) =>
        recentOnly(at, x) ? p.conns.filter(c => c.open && at - ms(c.lastUs) > MINUTE).length : undefined},
    {id: 'resets', group: 'network stats', label: 'connection resets', about: 'connections cut off with a tcp reset - refused or dropped, usually', window: 'last 30 s', format: fmtCount, keywords: ['rst', 'refused', 'errors', 'dropped'], at: (p, at, x) => (recentOnly(at, x) ? p.recent.resets.size : undefined)},
    {id: 'ports', group: 'network stats', label: 'ports used', about: 'different ports it talked to on the other end', period: 1, format: fmtCount, keywords: ['services', 'protocols'], of: (f, x) => new Set([...f.conns].map(id => x.conns.get(id)?.remotePort)).size},

    {id: 'distance', group: 'world stats', label: 'farthest', phrase: 'farthest reach', about: 'the farthest place it talked to, as the crow flies', period: 1, format: fmtKm, keywords: ['distance', 'far'], of: (f, x) => most(kms(f, x))},
    {id: 'closest', group: 'world stats', label: 'closest', about: 'the nearest place it talked to, as the crow flies', period: 1, format: fmtKm, lowFirst: true, keywords: ['distance', 'near'], of: (f, x) => least(kms(f, x))},
    {id: 'avg-distance', group: 'world stats', label: 'average distance', about: 'how far its data went on average, as the crow flies - weighted by how much went where', period: 1, format: fmtKm, keywords: ['distance', 'mean', 'typical'], of: (f, x) => {
        let km = 0, bytes = 0;
        for (const [ip, b] of f.bytesTo) {
            const d = x.places.get(ip)?.km;
            if (d !== undefined) (km += d * b), (bytes += b);
        }
        return bytes ? km / bytes : undefined;
    }},
    {id: 'total-distance', group: 'world stats', label: 'total distance', about: 'the length of every route it used, added up', period: 1, format: fmtKmTotal, keywords: ['distance', 'km'], of: (f, x) => total(routeKms(f, x))},
    {id: 'longest-route', group: 'world stats', label: 'longest route', about: 'its longest route, along the routers and cables it goes through', period: 1, format: fmtKm, keywords: ['distance', 'path'], of: (f, x) => most(routeKms(f, x))},
    {id: 'packet-distance', group: 'world stats', label: 'packet distance', about: 'how far all its packets went, added up - every packet times the length of its route', period: 1, format: fmtKmTotal, keywords: ['distance', 'km'], of: f => f.packetKm},
    {id: 'countries', group: 'world stats', label: 'countries', about: 'countries it talked to', period: 1, format: fmtCount, keywords: ['geography', 'places'], of: (f, x) => distinct(placesIn(f, x).map(p => p.country))},
    {id: 'data-abroad', group: 'world stats', label: 'data abroad', about: 'bytes to and from other countries than this one', period: 1, format: fmtBytes, keywords: ['international', 'foreign', 'overseas', 'countries'], of: (f, x) => bytesWhere(f, x, p => p.abroad)},
    {id: 'networks', group: 'world stats', label: 'networks', about: 'different networks it reached - google, amazon, your internet provider...', period: 1, format: fmtCount, keywords: ['asn', 'autonomous systems', 'isps', 'providers'], of: (f, x) => new Set(placesIn(f, x).flatMap(p => (p.asn ? [p.asn] : []))).size},
    {id: 'cables', group: 'world stats', label: 'undersea cables', phrase: 'cables crossed', about: 'undersea cables its routes cross', period: 1, format: fmtCount, keywords: ['submarine', 'ocean'], of: (f, x) => distinct(placesIn(f, x).flatMap(p => p.cables))},
    {id: 'hops', group: 'world stats', label: 'most hops', about: 'the most routers on one of its routes', period: 1, format: fmtCount, keywords: ['routers', 'traceroute'], of: (f, x) => most(placesIn(f, x).flatMap(p => (p.hops ? [p.hops] : [])))},

    {id: 'trackers', group: 'privacy stats', label: 'trackers', about: 'addresses it talked to that belong to trackers', period: 1, format: fmtCount, keywords: ['tracking', 'surveillance'], of: (f, x) => placesIn(f, x).filter(p => p.tracker).length},
    {id: 'tracker-data', group: 'privacy stats', label: 'data to trackers', about: 'bytes sent to and received from trackers', period: 1, format: fmtBytes, keywords: ['tracking', 'surveillance'], of: (f, x) => bytesWhere(f, x, p => p.tracker)},
    {id: 'ad-analytics', group: 'privacy stats', label: 'ad & analytics', about: "addresses it talked to that are there for advertising or analytics, by DuckDuckGo's categories", period: 1, format: fmtCount, keywords: ['ads', 'advertising', 'marketing', 'tracking'], of: (f, x) => placesIn(f, x).filter(p => p.ads).length},
    {id: 'companies', group: 'privacy stats', label: 'companies', about: 'companies on the other end', period: 1, format: fmtCount, keywords: ['owners', 'organizations'], of: (f, x) => distinct(placesIn(f, x).map(p => p.owner))},
    {id: 'unnamed', group: 'privacy stats', label: 'unnamed addresses', about: 'addresses it talked to with no name at all - no server name, dns answer or reverse lookup', period: 1, format: fmtCount, keywords: ['anonymous', 'raw ip', 'no hostname'], of: (f, x) => placesIn(f, x).filter(p => !p.named).length},
    {id: 'unencrypted', group: 'privacy stats', label: 'unencrypted', about: 'connections that sent readable text', period: 15, format: fmtCount, keywords: ['plaintext', 'http', 'insecure'], of: (f, x) => [...f.conns].filter(id => x.conns.get(id)?.plaintext).length},
    {id: 'unencrypted-data', group: 'privacy stats', label: 'unencrypted data', about: 'bytes over connections that sent readable text', period: 15, format: fmtBytes, keywords: ['plaintext', 'http', 'insecure'], of: f => f.plainBytes},

    {id: 'time-alive', group: 'time stats', label: 'time alive', about: 'how long since it started', window: 'now', format: fmtDuration, keywords: ['uptime', 'age', 'running'], at: (p, at) => (p.startMs === undefined || p.startMs > at ? undefined : at - p.startMs)},
    {id: 'active-minutes', group: 'time stats', label: 'minutes active', about: 'how many minutes it sent or received anything in', period: 15, minutesOnly: true, format: fmtCount, keywords: ['activity', 'busy', 'uptime'], of: f => f.activeMinutes},
    {id: 'longest-connection', group: 'time stats', label: 'longest connection', about: 'how long its longest-lived connection has been open', window: 'now', format: fmtDuration, keywords: ['duration', 'lifetime'], at: (p, at) =>
        most(p.conns.filter(c => ms(c.firstUs) <= at).map(c => (c.open ? at : Math.min(at, ms(c.lastUs))) - ms(c.firstUs)))},
    {id: 'avg-connection', group: 'time stats', label: 'average connection age', about: 'how long its connections have lasted, on average', window: 'now', format: fmtDuration, keywords: ['duration', 'lifetime', 'mean'], at: (p, at) => {
        const ages = p.conns.filter(c => ms(c.firstUs) <= at).map(c => (c.open ? at : Math.min(at, ms(c.lastUs))) - ms(c.firstUs));
        return ages.length ? total(ages)! / ages.length : undefined;
    }},
    {id: 'newest-connection', group: 'time stats', label: 'newest connection', about: 'how long since it opened a connection', window: 'now', format: n => `${fmtDuration(n)} ago`, lowFirst: true, keywords: ['recent', 'latest', 'opened'], at: (p, at) => {
        const firsts = p.conns.map(c => ms(c.firstUs)).filter(t => t <= at);
        return firsts.length ? at - Math.max(...firsts) : undefined;
    }},
    {id: 'last-active', group: 'time stats', label: 'last active', about: 'how long since it last sent or received anything', window: 'now', format: n => `${fmtDuration(n)} ago`, lowFirst: true, keywords: ['idle', 'recent', 'quiet'], at: (p, at, x) => {
        if (at >= x.nowMs) return p.lastMs ? Math.max(0, at - p.lastMs) : undefined;
        // before now, from whichever bars had traffic
        for (let i = p.bins.length - 1; i >= 0; i--) {
            const start = x.firstBinMs + i * x.binMs;
            if (start < at && p.bins[i].conns.size) return Math.max(0, at - Math.min(at, start + x.binMs));
        }
        return undefined;
    }},
];

// the stats matching what's been typed, best first: every word has to turn up in
// a stat's name, its keywords, its group or what it's about - and where it turns
// up decides the order. nothing typed is every stat, in the menu's order
export function searchMetrics(query: string): Metric[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return METRICS;
    const score = (m: Metric) => {
        let total = 0;
        for (const w of words) {
            const s = m.label.startsWith(w) ? 8
                : new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(m.label) ? 6
                : m.label.includes(w) ? 4
                : m.keywords?.some(k => k.startsWith(w)) ? 3
                : m.keywords?.some(k => k.includes(w)) ? 2
                : m.group.includes(w) ? 1
                : m.about.toLowerCase().includes(w) ? 0.5
                : 0;
            if (!s) return 0;
            total += s;
        }
        return total;
    };
    return METRICS.map(m => ({m, s: score(m)}))
        .filter(r => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .map(r => r.m);
}

export const DEFAULT_METRIC = 'upload-size';
export const phraseOf = (m: Metric) => m.phrase ?? m.label;
// what a stat covers, in words: the period it's on (or starts on), or its fixed window
export const windowOf = (m: Metric, periodMinutes = m.period) => m.window ?? periodLabel(periodMinutes ?? 1);
export const metricById = (id: string) => METRICS.find(m => m.id === id) ?? METRICS.find(m => m.id === DEFAULT_METRIC)!;

export type Proc = {
    key: string; // its pid - -1 for system traffic, 0 for what nothing matched
    name: string;
    pid: number;
    conns: Conn[]; // busiest first
    bytes: number;
    series: (number | undefined)[]; // the stat for each of the chart's bars, oldest first - the last one now
    value: number | undefined; // the stat now. undefined: no way to know (root's processes won't say how much cpu)
};

export const procKey = (c: Conn) => String(c.system ? -1 : c.pid);

// the world + privacy facts about everything the model's drawn. homeCountry is
// this machine's, for what counts as abroad
export function placesOf(groups: Iterable<Group>, home: LonLat | undefined, homeCountry = ''): Map<string, Place> {
    const out = new Map<string, Place>();
    for (const g of groups) {
        const ep = g.endpoint;
        const at = placeOf(ep, g.hops, home);
        const km = home && at ? distanceKm(home, at) : undefined;
        // geo-ip's answer only counts when it fits the round trip
        const country = ep.possible ? ep.countryCode : '';
        out.set(ep.ip, {
            km,
            routeKm: g.drawn?.km ?? km, // its route whether its line's drawn or not
            country,
            abroad: !!homeCountry && !!country && country !== homeCountry,
            owner: ep.kind === 'public' ? ep.owner || ep.org : '',
            asn: ep.asn,
            tracker: ep.tracker,
            ads: ep.categories.some(c => /advert|analytic|audience|marketing/i.test(c)),
            named: !!(ep.host || ep.ptr),
            cables: g.drawn?.cables ?? [],
            hops: g.hops.filter(h => h.ip).length,
            rttMs: ep.rttMs,
        });
    }
    return out;
}

// the last sixty seconds from per-minute rows: this minute so far, plus the part
// of the one before that's still inside the minute
export function lastMinute(prev: number, current: number, intoMinute: number): number {
    return current + prev * (1 - Math.min(1, Math.max(0, intoMinute)));
}

export function overview(
    conns: Conn[],
    rollups: Rollup[],
    usage: ProcUsage[],
    procRows: ProcRow[],
    places: Map<string, Place>,
    metric: Metric,
    pins: string[],
    nowMs: number,
    chunks: PacketChunk[] = [], // the live packets - the last 30 seconds, one by one
    periodMinutes = metric.period ?? 1, // how far back the stat looks, if it can be changed
): Proc[] {
    // under a minute, the stat's from single packets, not per-minute rows - up to the
    // newest of them
    const fromPackets = periodMinutes < 1;
    let endMs = nowMs;
    if (fromPackets) {
        endMs = nowMs - STALE_MS;
        for (const ch of chunks) for (const r of records(ch)) endMs = Math.max(endMs, r.timeUs / 1000);
    }
    // the chart's bars: aligned to the clock, the last one the bar so far
    const {n, binMs} = binsFor(periodMinutes);
    const lastBinMs = Math.floor(endMs / binMs) * binMs;
    const firstBinMs = lastBinMs - (n - 1) * binMs;
    const binOf = (atMs: number) => Math.floor((atMs - firstBinMs) / binMs);
    const bins = () => Array.from({length: n}, (_, i) => ({...noFacts(), spanMs: i === n - 1 ? endMs - lastBinMs : binMs}));
    // traffic on a connection, into one bar
    const addTraffic = (f: Facts, c: Conn, up: number, down: number, pkts: number, pktsUp: number) => {
        f.up += up;
        f.down += down;
        f.pkts += pkts;
        f.pktsUp += pktsUp;
        f.packetKm += pkts * (places.get(c.remoteIp)?.routeKm ?? 0);
        if (c.plaintext) f.plainBytes += up + down;
        f.conns.add(c.connId);
        f.ips.add(c.remoteIp);
        f.bytesTo.set(c.remoteIp, (f.bytesTo.get(c.remoteIp) ?? 0) + up + down);
    };
    const starts = new Map(procRows.map(r => [r.pid, ms(r.startUs)]));

    type P = Proc & {state: ProcState; minuteBytes: Map<number, number>};
    const procs = new Map<string, P>();
    const byConn = new Map<bigint, P>();
    const connById = new Map<bigint, Conn>();
    for (const c of conns) {
        const key = procKey(c);
        let p = procs.get(key);
        if (!p) {
            const pid = c.system ? -1 : c.pid;
            const name = pid === -1 ? 'system' : c.process || 'unknown';
            const state = {conns: [], startMs: pid > 0 ? starts.get(pid) : undefined, lastMs: 0, bins: bins(), recent: {times: [], resets: new Set<bigint>()}};
            p = {key, name, pid, conns: [], bytes: 0, series: [], value: undefined, state, minuteBytes: new Map()};
            procs.set(key, p);
        }
        p.conns.push(c);
        p.bytes += c.bytesUp + c.bytesDown;
        p.state.lastMs = Math.max(p.state.lastMs, ms(c.lastUs));
        p.state.bins[binOf(ms(c.firstUs))]?.opened.add(c.connId);
        byConn.set(c.connId, p);
        connById.set(c.connId, c);
    }
    for (const p of procs.values()) p.state.conns = p.conns;

    for (const r of fromPackets ? [] : rollups) {
        const p = byConn.get(r.connId);
        const minute = ms(r.minuteUs);
        const f = p?.state.bins[binOf(minute)];
        if (!f) continue;
        addTraffic(f, connById.get(r.connId)!, r.bytesUp, r.bytesDown, r.pkts, r.pktsUp);
        p!.minuteBytes.set(minute, (p!.minuteBytes.get(minute) ?? 0) + r.bytesUp + r.bytesDown);
    }
    // minute by minute, for the busiest one and the minutes active
    for (const p of procs.values()) {
        for (const [minute, bytes] of p.minuteBytes) {
            const f = p.state.bins[binOf(minute)];
            if (!f) continue;
            f.peak = Math.max(f.peak, bytes / (Math.min(MINUTE, Math.max(1000, endMs - minute)) / 1000));
            f.activeMinutes++;
        }
    }
    for (const u of fromPackets ? [] : usage) {
        const minute = ms(u.minuteUs);
        const f = procs.get(String(u.pid))?.state.bins[binOf(minute)];
        if (!f) continue;
        f.cpuMs += u.cpuMs;
        f.diskBytes += u.diskBytes;
        f.memBytes = Math.max(f.memBytes, u.memBytes);
        if (minute >= f.memAt) (f.memLatest = u.memBytes), (f.memAt = minute);
        f.measured = true;
        // the minute that's still going only covers so much yet
        f.usageSpanMs += Math.min(MINUTE, endMs - minute);
    }
    for (const ch of chunks) {
        const p = byConn.get(ch.connId);
        if (!p) continue;
        const c = connById.get(ch.connId)!;
        const w = ch.weight; // 1 in w packets was recorded
        for (const r of records(ch)) {
            p.state.recent.times.push(r.timeUs / 1000);
            if (c.proto === 6 && r.flags & TCP_FLAGS.RST) p.state.recent.resets.add(c.connId);
            const f = fromPackets ? p.state.bins[binOf(r.timeUs / 1000)] : undefined;
            if (f) addTraffic(f, c, r.out ? r.size * w : 0, r.out ? 0 : r.size * w, w, r.out ? w : 0);
        }
    }

    const x: Ctx = {places, conns: connById, nowMs: endMs, firstBinMs, binMs};
    const into = (endMs - lastBinMs) / binMs;
    const from = endMs - periodMinutes * MINUTE;
    for (const p of procs.values()) {
        const b = p.state.bins;
        if (metric.at) {
            // where it stood at the end of each bar, and now
            p.series = b.map((_, i) => metric.at!(p.state, i === n - 1 ? endMs : firstBinMs + (i + 1) * binMs, x));
            p.value = p.series[n - 1];
        } else {
            // each bar as it was - the last one a bar's worth up to now, so it doesn't
            // dip just for being young - and the value over the whole period, the
            // oldest bar in it counted for the part that's inside
            p.series = b.map((f, i) => metric.of!(i === n - 1 && n > 1 ? merge(f, b[n - 2], 1 - into) : f, x));
            let span = noFacts();
            b.forEach((f, i) => {
                const start = firstBinMs + i * binMs, end = i === n - 1 ? endMs : start + binMs;
                if (end > from) span = merge(span, f, start >= from ? 1 : (end - from) / (end - start));
            });
            p.value = metric.of!(span, x);
        }
        p.conns.sort((a, b) => b.bytesUp + b.bytesDown - (a.bytesUp + a.bytesDown));
    }

    const pinned = (p: Proc) => {
        const i = pins.indexOf(p.key);
        return i < 0 ? Infinity : i;
    };
    // unknowns go last, whichever way round
    const rank = (p: Proc) => (p.value === undefined ? Infinity : metric.lowFirst ? p.value : -p.value);
    return [...procs.values()]
        .map(({state: _, minuteBytes: __, ...p}) => p)
        .sort((a, b) => pinned(a) - pinned(b) || rank(a) - rank(b) || b.bytes - a.bytes || a.name.localeCompare(b.name));
}

// one process close up, for the inspector - what it's sent and received, and what the
// agent says it costs
export type Inspection = {
    up: number;
    down: number;
    packetsSent: number; // in the last minute
    totalSent: number; // since its connections opened
    totalReceived: number;
    open: number;
    medianMs?: number;
    cpu?: number;
    memory?: number;
    aliveMs?: number;
};

export function inspect(p: Proc, rollups: Rollup[], usage: ProcUsage[], procRows: ProcRow[], places: Map<string, Place>, nowMs: number): Inspection {
    // the last minute, whatever period the overview's on
    const value = (id: string) => overview(p.conns, rollups, usage, procRows, places, metricById(id), [], nowMs, [], 1)[0]?.value;
    // a connection's own round trip if the agent saw one, otherwise its address's best
    const rtts = p.conns
        .flatMap(c => {
            const rtt = c.rttMs > 0 ? c.rttMs : (places.get(c.remoteIp)?.rttMs ?? 0);
            return rtt > 0 ? [rtt] : [];
        })
        .sort((a, b) => a - b);
    const mid = rtts.length >> 1;
    return {
        up: value('upload-size') ?? 0,
        down: value('download-size') ?? 0,
        packetsSent: value('packets-sent') ?? 0,
        totalSent: p.conns.reduce((n, c) => n + c.pktsUp, 0),
        totalReceived: p.conns.reduce((n, c) => n + c.pktsDown, 0),
        open: p.conns.filter(c => c.open).length,
        medianMs: rtts.length ? (rtts.length % 2 ? rtts[mid] : (rtts[mid - 1] + rtts[mid]) / 2) : undefined,
        cpu: value('cpu'),
        memory: value('memory'),
        aliveMs: value('time-alive'),
    };
}
