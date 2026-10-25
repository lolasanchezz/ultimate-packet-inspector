import {describe, expect, it} from 'vitest';
import type {Conn, Endpoint, PacketChunk, ProcRow, ProcUsage, Rollup} from './db';
import type {Hop} from './paths';
import {placeOf} from './scene';
import {METRICS, MINUTES, binsFor, inspect, jitterOf, lastMinute, metricById, overview, periodsFor, searchMetrics, type Place} from './stats';

const NOW = 1_800_000_030_000; // 30s into a minute
const MIN = 1_800_000_000_000;
const us = (ms: number) => BigInt(ms) * 1000n;

let nextId = 1n;
function conn(pid: number, process: string, remoteIp: string, extra: Partial<Conn> = {}): Conn {
    return {
        key: `1/${nextId}`, machineId: 1, connId: nextId++, pid, process, proto: 6, remoteIp, remotePort: 443, localPort: 50000, host: '',
        firstUs: us(NOW - 600_000), lastUs: us(NOW), bytesUp: 1000, bytesDown: 1000, pktsUp: 1, pktsDown: 1, rttMs: 0,
        open: true, plaintext: false, system: false, ...extra,
    };
}
const rollup = (c: Conn, minuteMs: number, bytesUp: number, bytesDown = 0, pkts = 1, pktsUp = 0): Rollup => ({
    key: `1/${c.connId}/${minuteMs}`, machineId: 1, connId: c.connId, minuteUs: us(minuteMs), bytesUp, bytesDown, pkts, pktsUp,
});
const usage = (pid: number, minuteMs: number, cpuMs: number, memBytes = 0, diskBytes = 0): ProcUsage => ({
    key: `1/${pid}/${minuteMs}`, machineId: 1, pid, process: '', minuteUs: us(minuteMs), cpuMs, memBytes, diskBytes,
});
const started = (pid: number, ms: number): ProcRow => ({key: `1/${pid}`, machineId: 1, pid, process: '', startUs: us(ms), lastUs: us(NOW)});
const place = (p: Partial<Place>): Place => ({country: '', abroad: false, owner: '', asn: 0, tracker: false, ads: false, named: true, cables: [], hops: 0, rttMs: 0, ...p});

// packets the way the agent packs them, 8 bytes each: [ms before NOW, size, sent?]
let nextChunk = 100n;
function chunk(c: Conn, packets: [number, number, boolean][], weight = 1): PacketChunk {
    const t0 = (NOW - 60_000) * 1000;
    const bytes = new Uint8Array(packets.length * 8);
    const view = new DataView(bytes.buffer);
    packets.forEach(([before, size, out], i) => {
        view.setUint32(i * 8, (NOW - before) * 1000 - t0, true);
        view.setUint16(i * 8 + 4, size, true);
        bytes[i * 8 + 6] = out ? 0x80 : 0;
    });
    return {id: nextChunk++, machineId: 1, connId: c.connId, t0Us: BigInt(t0), n: packets.length, weight, data: btoa(String.fromCharCode(...bytes))};
}

const run = (id: string, conns: Conn[], rollups: Rollup[], extra: {usage?: ProcUsage[]; procs?: ProcRow[]; places?: Record<string, Place>; pins?: string[]} = {}) =>
    overview(conns, rollups, extra.usage ?? [], extra.procs ?? [], new Map(Object.entries(extra.places ?? {})), metricById(id), extra.pins ?? [], NOW);
const values = (procs: ReturnType<typeof run>) => procs.map(p => [p.name, p.value]);

describe('stats', () => {
    it('slides a minute across per-minute rows', () => {
        // half way into this minute: all of it, and half of the last
        expect(lastMinute(100, 40, 0.5)).toBe(90);
        expect(lastMinute(100, 40, 0)).toBe(140);
    });

    it('ranks every pid by data uploaded, with its last minutes', () => {
        const music = conn(101, 'Music', '17.0.0.1');
        const arc = conn(83, 'Arc', '1.1.1.1');
        const arc2 = conn(84, 'Arc', '1.1.1.1'); // a second arc process is its own row
        const procs = run('upload-size', [music, arc, arc2], [rollup(music, MIN, 600), rollup(music, MIN - 60_000, 1000), rollup(arc, MIN, 5000), rollup(arc, MIN - 5 * 60_000, 99)]);
        expect(procs.map(p => [p.name, p.pid, p.value])).toEqual([['Arc', 83, 5000], ['Music', 101, 1100], ['Arc', 84, 0]]);
        expect(procs[0].series).toHaveLength(MINUTES + 1); // and the bar the period starts in
        expect(procs[0].series.at(-6)).toBe(99);
        expect(procs[0].series.at(-1)).toBe(5000);
        expect(metricById('nonsense').id).toBe('upload-size');
    });

    it('keeps pinned processes on top, in the order they were pinned', () => {
        const a = conn(1, 'a', '1.1.1.1', {bytesUp: 10});
        const b = conn(2, 'b', '1.1.1.1', {bytesUp: 20});
        const c = conn(3, 'c', '1.1.1.1', {bytesUp: 30});
        const procs = run('upload-size', [a, b, c], [rollup(a, MIN, 10), rollup(b, MIN, 20), rollup(c, MIN, 30)], {pins: ['2', '1']});
        expect(procs.map(p => p.name)).toEqual(['b', 'a', 'c']);
    });

    it('counts system and unmatched traffic as one row each', () => {
        const procs = run('upload-size', [conn(-1, '', '224.0.0.251', {system: true}), conn(0, '', '1.1.1.1'), conn(0, '', '8.8.8.8')], []);
        expect(procs.map(p => [p.name, p.conns.length]).sort()).toEqual([['system', 1], ['unknown', 2]]);
    });

    it('counts packets each way, and connections', () => {
        const a = conn(5, 'curl', '1.1.1.1');
        const b = conn(5, 'curl', '8.8.8.8');
        const rows = [rollup(a, MIN, 0, 0, 10, 4), rollup(b, MIN, 0, 0, 6, 6)];
        expect(values(run('packets-sent', [a, b], rows))).toEqual([['curl', 10]]);
        expect(values(run('packets-received', [a, b], rows))).toEqual([['curl', 6]]);
        expect(values(run('connections', [a, b], rows))).toEqual([['curl', 2]]);
    });

    it('measures how far a process reaches, every way', () => {
        const near = conn(5, 'curl', '10.1.1.1');
        const far = conn(5, 'curl', '20.2.2.2');
        const quiet = conn(5, 'curl', '30.3.3.3'); // nothing went there in the last minute
        const places = {
            '10.1.1.1': place({km: 70, routeKm: 90, country: 'US', rttMs: 4}),
            '20.2.2.2': place({km: 11_950, routeKm: 13_000, country: 'AU', cables: ['Southern Cross'], hops: 14, rttMs: 160}),
            '30.3.3.3': place({km: 8_270, routeKm: 9_000, country: 'JP'}),
        };
        const rows = [rollup(near, MIN, 1, 0, 2), rollup(far, MIN - 60_000, 0, 1, 10)];
        const got = (id: string) => run(id, [near, far, quiet], rows, {places})[0].value;
        expect(got('distance')).toBe(11_950);
        expect(got('closest')).toBe(70);
        expect(got('total-distance')).toBe(13_090);
        expect(got('longest-route')).toBe(13_000);
        expect(got('packet-distance')).toBe(2 * 90 + 10 * 13_000 * 0.5); // half of last minute's still in it
        expect(got('countries')).toBe(2);
        expect(got('cables')).toBe(1);
        expect(got('hops')).toBe(14);
        expect(got('round-trip')).toBe(82);
    });

    it('puts the closest first, and the ones with nowhere to measure last', () => {
        const a = conn(1, 'a', '1.1.1.1');
        const b = conn(2, 'b', '2.2.2.2');
        const c = conn(3, 'c', '3.3.3.3');
        const places = {'1.1.1.1': place({km: 900}), '2.2.2.2': place({km: 30})};
        const procs = run('closest', [a, b, c], [rollup(a, MIN, 1), rollup(b, MIN, 1), rollup(c, MIN, 1)], {places});
        expect(values(procs)).toEqual([['b', 30], ['a', 900], ['c', undefined]]);
    });

    it('knows who it talked to', () => {
        const a = conn(1, 'app', '1.1.1.1', {plaintext: true});
        const b = conn(1, 'app', '2.2.2.2');
        const places = {'1.1.1.1': place({owner: 'Google LLC', tracker: true}), '2.2.2.2': place({owner: 'Google LLC'})};
        const rows = [rollup(a, MIN - 10 * 60_000, 1), rollup(b, MIN, 1)];
        expect(run('trackers', [a, b], rows, {places})[0].value).toBe(0); // the tracker was ten minutes ago
        expect(run('companies', [a, b], rows, {places})[0].value).toBe(1);
        expect(run('unencrypted', [a, b], rows, {places})[0].value).toBe(1); // over 15 minutes, it counts
    });

    it("uses the agent's process usage, and knows when there isn't any", () => {
        const mine = conn(7, 'Music', '1.1.1.1');
        const roots = conn(8, 'mDNSResponder', '1.1.1.1');
        const rows = [usage(7, MIN, 15_000, 300e6), usage(7, MIN - 60_000, 6_000, 200e6)];
        const procs = run('cpu', [mine, roots], [], {usage: rows});
        expect(procs.map(p => p.name)).toEqual(['Music', 'mDNSResponder']);
        expect(procs[0].value).toBeCloseTo(30); // (15s + half of 6s) of cpu over 60s
        expect(procs[1].value).toBeUndefined();
        expect(run('cpu-time', [mine], [], {usage: rows})[0].value).toBe(21_000);
        expect(run('memory', [mine], [], {usage: rows})[0].value).toBe(300e6);
    });

    it('tells the time', () => {
        const old = conn(7, 'Music', '1.1.1.1', {firstUs: us(NOW - 3_600_000), lastUs: us(NOW - 5_000)});
        const shortLived = conn(9, 'curl', '1.1.1.1', {firstUs: us(NOW - 20_000), lastUs: us(NOW - 10_000), open: false});
        const procs = [started(7, NOW - 86_400_000)];
        expect(values(run('time-alive', [old, shortLived], [], {procs}))).toEqual([['Music', 86_400_000], ['curl', undefined]]);
        expect(values(run('longest-connection', [old, shortLived], []))).toEqual([['Music', 3_600_000], ['curl', 10_000]]);
        expect(values(run('last-active', [old, shortLived], []))).toEqual([['Music', 5_000], ['curl', 10_000]]);
        // a process a minute older at every point back
        const series = run('time-alive', [old], [], {procs})[0].series;
        expect(series.at(-2)! - series.at(-3)!).toBe(60_000);
    });

    it('inspects one process', () => {
        const a = conn(7, 'Music', '1.1.1.1', {rttMs: 20});
        const b = conn(7, 'Music', '2.2.2.2', {open: false});
        const c = conn(7, 'Music', '3.3.3.3');
        const places = {'2.2.2.2': place({rttMs: 90}), '3.3.3.3': place({rttMs: 40})};
        const [p] = run('upload-size', [a, b, c], []);
        const got = inspect(p, [rollup(a, MIN, 500, 7000, 12, 5), rollup(b, MIN, 100, 0, 1, 1)], [usage(7, MIN, 6_000, 1e8)], [started(7, NOW - 60_000)], new Map(Object.entries(places)), NOW);
        // 6s of cpu in the 30s of this minute so far
        expect(got).toEqual({up: 600, down: 7000, packetsSent: 6, totalSent: 3, totalReceived: 3, open: 2, medianMs: 40, cpu: 20, memory: 1e8, aliveMs: 60_000});
    });

    it("ignores geo-ip when it doesn't fit the round trip", () => {
        const ep = (extra: Partial<Endpoint>): Endpoint => ({
            key: '1/1.1.1.1', machineId: 1, ip: '1.1.1.1', kind: 'public', host: '', ptr: '', lat: -33.87, lon: 151.21, located: true, city: 'Sydney',
            region: '', country: 'Australia', countryCode: 'AU', asn: 13335, org: '', owner: '', categories: [], tracker: false, rttMs: 4,
            possible: true, drawnLat: -33.87, drawnLon: 151.21, route: '', lastUs: 0n, ...extra,
        });
        const hop = (extra: Partial<Hop>): Hop => ({ttl: 1, ip: '10.0.0.1', rttMs: 1, ptr: '', asn: 0, org: '', lat: 0, lon: 0, located: false, city: '', country: '', from: 'geoip', possible: true, ...extra});
        const sanJose = hop({ttl: 2, ip: '172.68.188.133', lat: 37.34, lon: -121.89, located: true});
        const wrong = hop({ttl: 3, ip: '1.1.1.1', lat: -33.87, lon: 151.21, located: false, possible: false});
        expect(placeOf(ep({}), [])).toEqual([151.21, -33.87]); // believable - where geo-ip says
        expect(placeOf(ep({possible: false, drawnLat: 37, drawnLon: -122}), [hop({}), sanJose, wrong])).toEqual([-121.89, 37.34]); // the last believable router
        expect(placeOf(ep({possible: false}), [hop({}), wrong])).toBeUndefined(); // nowhere believable
        expect(placeOf(ep({kind: 'lan'}), [])).toBeUndefined();
        // the router has to be somewhere its own round trip could reach, too: 4ms from
        // san francisco is 400km - san jose fits, new york doesn't
        const newYork = hop({ttl: 3, ip: '4.4.4.4', lat: 40.71, lon: -74.01, located: true});
        expect(placeOf(ep({possible: false}), [sanJose, newYork, wrong], [-122.42, 37.77])).toEqual([-121.89, 37.34]);
    });

    it('measures bandwidth, packet throughput and the time between packets', () => {
        const a = conn(5, 'curl', '1.1.1.1');
        // all in this minute, so the last minute is exactly these
        const rows = [rollup(a, MIN, 3000, 3000, 120, 40)];
        const at30 = MIN + 60_000 - 1; // the very end of the minute - none of the one before still counts
        const got = (id: string) => overview([a], rows, [], [], new Map(), metricById(id), [], at30)[0].value;
        expect(got('bandwidth')).toBe(100); // 6000 bytes over 60s
        expect(got('packet-rate')).toBe(2);
        expect(got('packet-gap')).toBe(500); // 120 packets in a minute
        expect(got('avg-packet')).toBe(50);
        expect(got('upload-share')).toBe(50);
        expect(run('packet-gap', [conn(6, 'quiet', '1.1.1.1')], [])[0].value).toBeUndefined(); // no packets, no gap
    });

    it('finds the busiest minute, the minutes active and the connections opened', () => {
        const a = conn(5, 'curl', '1.1.1.1', {firstUs: us(MIN + 5_000)});
        const b = conn(5, 'curl', '2.2.2.2', {firstUs: us(MIN - 10 * 60_000)});
        const rows = [rollup(a, MIN, 6000), rollup(b, MIN - 3 * 60_000, 600), rollup(b, MIN - 10 * 60_000, 60)];
        // 6000 bytes in this minute's first 30 seconds - 200 a second, not 100
        expect(run('peak-bandwidth', [a, b], rows)[0].value).toBe(200);
        expect(run('active-minutes', [a, b], rows)[0].value).toBe(3);
        expect(run('new-connections', [a, b], rows)[0].value).toBe(1);
    });

    it('weighs distance by data, and counts networks, trackers and what goes abroad', () => {
        const near = conn(5, 'curl', '10.1.1.1');
        const far = conn(5, 'curl', '20.2.2.2');
        const places = {
            '10.1.1.1': place({km: 100, asn: 13335, country: 'US'}),
            '20.2.2.2': place({km: 10_000, asn: 15169, country: 'AU', abroad: true, tracker: true, ads: true, named: false}),
        };
        const rows = [rollup(near, MIN, 900), rollup(far, MIN, 100)];
        const got = (id: string) => run(id, [near, far], rows, {places})[0].value;
        expect(got('avg-distance')).toBe(1090); // nine tenths of it went 100km
        expect(got('networks')).toBe(2);
        expect(got('data-abroad')).toBe(100);
        expect(got('tracker-data')).toBe(100);
        expect(got('ad-analytics')).toBe(1);
        expect(got('unnamed')).toBe(1);
    });

    it('reads jitter and resets from the last 30 seconds of packets', () => {
        expect(jitterOf([0, 10, 20, 30])).toBe(0); // perfectly steady
        expect(jitterOf([0, 10, 40])).toBe(10); // gaps of 10 and 30
        expect(jitterOf([0, 10])).toBeUndefined();
        const a = conn(5, 'curl', '1.1.1.1');
        // two packets 8 bytes each: the second a reset (flags 0x04), sampled 1 in 3
        const t0 = (NOW - 5_000) * 1000;
        const bytes = new Uint8Array(16);
        new DataView(bytes.buffer).setUint32(8, 2000, true);
        bytes[14] = 0x04;
        const chunk: PacketChunk = {id: 1n, machineId: 1, connId: a.connId, t0Us: BigInt(t0), n: 2, weight: 3, data: btoa(String.fromCharCode(...bytes))};
        const [p] = overview([a], [], [], [], new Map(), metricById('resets'), [], NOW, [chunk]);
        expect(p.value).toBe(1); // one connection, however many resets it sent
        expect(p.series.slice(0, -1).every(v => v === undefined)).toBe(true); // only now is known
    });

    it('searches by name, keyword and what a stat is about - best first', () => {
        const ids = (q: string) => searchMetrics(q).map(m => m.id);
        expect(ids('bandwidth')[0]).toBe('bandwidth');
        expect(ids('ram')).toEqual(['memory', 'peak-memory']);
        expect(ids('latency')).toEqual(expect.arrayContaining(['round-trip', 'jitter']));
        expect(ids('time between')[0]).toBe('packet-gap');
        expect(ids('peak band')).toEqual(['peak-bandwidth']);
        expect(ids('zzz')).toEqual([]);
        expect(searchMetrics('')).toBe(METRICS);
        expect(new Set(METRICS.map(m => m.id)).size).toBe(METRICS.length); // no two the same
    });

    it('works a stat out over whichever period it is set to', () => {
        const a = conn(5, 'curl', '1.1.1.1', {firstUs: us(MIN - 50 * 60_000)});
        const rows = [rollup(a, MIN, 600), rollup(a, MIN - 30 * 60_000, 6000), rollup(a, MIN - 50 * 60_000, 60_000)];
        const sized = (minutes: number) => overview([a], rows, [], [], new Map(), metricById('upload-size'), [], NOW, [], minutes)[0];
        expect(sized(1).value).toBe(600);
        expect(sized(15).value).toBe(600);
        expect(sized(60).value).toBe(66_600);
        // a speed is over the whole period: 66,600 bytes in an hour
        const speed = overview([a], rows, [], [], new Map(), metricById('upload-speed'), [], NOW, [], 60)[0].value!;
        expect(speed).toBeCloseTo(66_600 / 3600, 0);
        // an hour on the chart is 30 bars of 2 minutes, and the one it starts part way through
        expect(sized(60).series).toHaveLength(31);
        expect(binsFor(60)).toEqual({n: 31, binMs: 2 * 60_000});
        expect(binsFor(1)).toEqual({n: 16, binMs: 60_000});
        expect(binsFor(1440)).toEqual({n: 31, binMs: 48 * 60_000});
    });

    it('counts the whole period, however far into a bar it is', () => {
        // a steady 1000 bytes a minute - half of that so far this minute, 30s in
        const a = conn(5, 'curl', '1.1.1.1', {firstUs: us(MIN - 30 * 60 * 60_000)});
        const rows = [rollup(a, MIN, 500), ...Array.from({length: 1500}, (_, i) => rollup(a, MIN - (i + 1) * 60_000, 1000))];
        const over = (minutes: number) => overview([a], rows, [], [], new Map(), metricById('upload-size'), [], NOW, [], minutes)[0].value;
        expect(over(15)).toBeCloseTo(15_000);
        expect(over(60)).toBeCloseTo(60_000);
        expect(over(1440)).toBeCloseTo(1_440_000);
    });

    it('works the last 15 and 30 seconds out from single packets', () => {
        const a = conn(5, 'curl', '1.1.1.1');
        const b = conn(5, 'curl', '8.8.8.8');
        // the newest packet's 2s old, so that's where the window ends
        const chunks = [
            chunk(a, [[2_000, 100, true], [10_000, 200, true], [20_000, 400, true], [12_000, 1000, false]]),
            chunk(b, [[5_000, 50, true]], 3), // sampled, 1 in 3
        ];
        const rows = [rollup(a, MIN, 99_999)]; // per-minute rows don't count under a minute
        const at = (id: string, minutes: number) => overview([a, b], rows, [], [], new Map(), metricById(id), [], NOW, chunks, minutes)[0];
        expect(at('upload-size', 0.25).value).toBe(450); // 100 + 200, and b's 50 three times
        expect(at('upload-size', 0.5).value).toBe(850); // and the one 20s back
        expect(at('download-size', 0.25).value).toBe(1000);
        expect(at('packets-sent', 0.25).value).toBe(5);
        expect(at('upload-speed', 0.25).value).toBeCloseTo(450 / 15);
        expect(at('connections', 0.25).value).toBe(2);
        expect(at('upload-size', 1).value).toBe(99_999); // a minute's still from the rows
        // the chart is those 30 seconds, a bar a second (and one more for where it starts)
        const series = at('upload-size', 0.5).series;
        expect(series).toHaveLength(31);
        expect(series[31 - 1 - 8]).toBe(200); // the bar 10s back, 8 before the last
        expect(binsFor(0.25)).toEqual({n: 31, binMs: 1000});
    });

    it('keeps on going without packets once they stop coming', () => {
        const a = conn(5, 'curl', '1.1.1.1');
        // nothing for 25s: the window carries on to 5s ago and leaves this behind
        const chunks = [chunk(a, [[25_000, 100, true]])];
        expect(overview([a], [], [], [], new Map(), metricById('upload-size'), [], NOW, chunks, 0.25)[0].value).toBe(0);
    });

    it('only offers periods under a minute to stats that can have them', () => {
        const minutes = (id: string) => periodsFor(metricById(id)).map(p => p.minutes);
        expect(minutes('bandwidth')).toEqual([0.25, 0.5, 1, 5, 15, 60, 360, 1440]);
        expect(minutes('cpu')).toEqual([1, 5, 15, 60, 360, 1440]);
        expect(minutes('peak-bandwidth')[0]).toBe(1);
    });
});
