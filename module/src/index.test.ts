import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { TestAuth, TestClock, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from './index';

const SECOND = 1_000_000n;
const MINUTE = 60n * SECOND;
const START = 1_800_000_000n * SECOND;

// someone connecting with their own identity
let nextConn = 1n;
const as = (sub: string) =>
  TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://upi.test', sub, iat: 0, exp: 4_000_000_000 }), new ConnectionId(nextConn++));

function setup() {
  const clock = new TestClock(new Timestamp(START));
  const h = createModuleTestHarness(spacetimedb, mod, { clock });
  const agent = as('agent');
  const website = as('website');
  const stranger = as('stranger');
  const call = <A>(auth: TestAuth, reducer: (ctx: any, args: A) => void, args: A) =>
    h.withReducerTx(auth, ctx => reducer(ctx, args));
  const view = <T>(auth: TestAuth, v: (ctx: any, args: {}) => T) => v(h.viewContext(auth), {});
  return { h, clock, agent, website, stranger, call, view };
}

// a batch like the agent sends - see agent/upload/batch.go
function batch(t: bigint, extra: Partial<Record<string, unknown>> = {}) {
  const tUs = Number(t);
  return JSON.stringify({
    t: tUs,
    stats: { iface: 'en0', pps: 12.5, dropped: 0, nstat: true, geo: true, sampled: 1 },
    home: { lat: 37.77, lon: -122.42, place: 'San Francisco, US' },
    conns: [
      {
        id: 1_800_000_000_000_001, pid: 4242, process: 'curl', proto: 6, remoteIp: '151.101.64.81', remotePort: 443,
        localPort: 51000, host: 'www.bbc.co.uk', firstUs: tUs - 1000, lastUs: tUs, bytesUp: 900, bytesDown: 80000,
        pktsUp: 12, pktsDown: 60, dUp: 900, dDown: 80000, dPkts: 72, dPktsUp: 12, rttMs: 24.8, open: true, plaintext: false, system: false,
      },
    ],
    endpoints: [
      {
        ip: '151.101.64.81', kind: 'public', host: 'www.bbc.co.uk', ptr: '', lat: 45.5, lon: -73.57, located: true,
        city: 'Montreal', region: 'Quebec', country: 'Canada', countryCode: 'CA', asn: 54113, org: 'Fastly, Inc.',
        owner: 'Fastly, Inc.', categories: [], tracker: false, rttMs: 24.8, possible: false, drawnLat: 37.3, drawnLon: -121.9,
        route: '151.101.64.0/24',
      },
    ],
    routes: [{ prefix: '151.101.64.0/24', dst: '151.101.64.81', tracedUs: tUs, hops: [{ ttl: 1, ip: '10.0.0.1', rttMs: 3 }] }],
    chunks: [{ conn: 1_800_000_000_000_001, t0: tUs - 1000, n: 1, w: 1, data: 'AAAAAEoAgkA=' }],
    procs: [
      { pid: 4242, process: 'curl', startUs: Number(START - 3600n * SECOND), measured: true, cpuMs: 120, mem: 5_000_000, disk: 4096 },
      { pid: 88, process: 'mDNSResponder', startUs: Number(START - 86400n * SECOND), measured: false }, // root's - only when it started
      { pid: -1, process: 'system', cpuMs: 1, mem: 1, disk: 1 }, // not a process - ignored
    ],
    ...extra,
  });
}

describe('upi module', () => {
  it('only lets a registered agent push', () => {
    const { h, agent, call } = setup();
    expect(() => call(agent, mod.ingest, { batch: batch(START) })).toThrow(/no machine/);
    call(agent, mod.registerMachine, { name: 'lola-mbp', iface: 'en0' });
    call(agent, mod.ingest, { batch: batch(START) });

    const m = [...h.db.machine.iter()][0];
    expect(m.name).toBe('lola-mbp');
    expect(m.homePlace).toBe('San Francisco, US');
    expect(m.pps).toBe(12.5);
    const c = h.db.conn.key.find(`${m.id}/1800000000000001`)!;
    expect(c.process).toBe('curl');
    expect(c.bytesDown).toBe(80000);
    expect(h.db.endpoint.key.find(`${m.id}/151.101.64.81`)!.possible).toBe(false);
    expect([...h.db.packetChunk.iter()]).toHaveLength(1);
    expect([...h.db.liveChunk.iter()]).toHaveLength(1);
    expect([...h.db.traffic.iter()][0].pkts).toBe(72);
    expect([...h.db.rollup.iter()][0].bytesDown).toBe(80000);
    expect([...h.db.procUsage.iter()].map(p => [p.pid, p.process, p.cpuMs])).toEqual([[4242, 'curl', 120]]);
    expect([...h.db.proc.iter()].map(p => [p.pid, p.startUs]).sort()).toEqual([[4242, START - 3600n * SECOND], [88, START - 86400n * SECOND]].sort());
    expect([...h.db.rollup.iter()][0].pktsUp).toBe(12);
  });

  it('adds up a minute of process usage', () => {
    const { h, agent, call } = setup();
    call(agent, mod.registerMachine, { name: 'm', iface: 'en0' });
    call(agent, mod.ingest, { batch: batch(START) });
    call(agent, mod.ingest, {
      batch: batch(START + 2n * SECOND, { procs: [{ pid: 4242, process: 'curl', cpuMs: 30, mem: 3_000_000, disk: 1000 }] }),
    });
    const [p] = [...h.db.procUsage.iter()];
    expect(p.cpuMs).toBe(150); // summed
    expect(p.diskBytes).toBe(5096);
    expect(p.memBytes).toBe(5_000_000); // the most it had
  });

  it("doesn't count a retried batch twice", () => {
    const { h, agent, call } = setup();
    call(agent, mod.registerMachine, { name: 'm', iface: 'en0' });
    // it went in, but the agent never heard back, so it sent it again
    call(agent, mod.ingest, { batch: batch(START) });
    call(agent, mod.ingest, { batch: batch(START) });
    expect([...h.db.rollup.iter()][0].bytesDown).toBe(80000);
    expect([...h.db.traffic.iter()][0].pkts).toBe(72);
    expect([...h.db.procUsage.iter()][0].cpuMs).toBe(120);
    expect([...h.db.packetChunk.iter()]).toHaveLength(1);
    // the next one's counted as usual
    call(agent, mod.ingest, { batch: batch(START + 2n * SECOND) });
    expect([...h.db.rollup.iter()][0].bytesDown).toBe(160000);
  });

  it("ingests exactly what the go agent sends", () => {
    const { h, agent, call } = setup();
    call(agent, mod.registerMachine, { name: 'm', iface: 'en0' });
    // written by the agent's TestBatchFixture
    call(agent, mod.ingest, { batch: readFileSync(new URL('../../testdata/batch.json', import.meta.url), 'utf8') });
    const [c] = [...h.db.conn.iter()];
    expect(c.process).toBe('curl');
    expect(c.remoteIp).toBe('1.1.1.1');
    expect(c.bytesUp + c.bytesDown).toBe(1620);
    const [e] = [...h.db.endpoint.iter()];
    expect(e.host).toBe('one.one.one.one');
    expect(e.possible).toBe(false); // sydney, answering in 4ms
    expect(e.drawnLat).toBeCloseTo(37.34); // so it's drawn at the san jose hop
    const [r] = [...h.db.route.iter()];
    expect(JSON.parse(r.hops)).toHaveLength(2);
    const [chunk] = [...h.db.packetChunk.iter()];
    expect(chunk.n).toBe(2);
  });

  it('rejects junk', () => {
    const { agent, call } = setup();
    call(agent, mod.registerMachine, { name: 'm', iface: 'en0' });
    expect(() => call(agent, mod.ingest, { batch: '{not json' })).toThrow(/not json/);
  });

  it('shows nothing until a website pairs, then only that machine', () => {
    const { clock, agent, website, stranger, call, view } = setup();
    call(agent, mod.registerMachine, { name: 'lola-mbp', iface: 'en0' });
    call(agent, mod.ingest, { batch: batch(START) });

    expect(view(website, mod.myMachines)).toEqual([]);
    expect(view(website, mod.myConns)).toEqual([]);

    call(agent, mod.setPairCode, { code: 'ABCD2345' });
    expect(() => call(stranger, mod.claimMachine, { code: 'WRONG234' })).toThrow(/isn't valid/);
    call(website, mod.claimMachine, { code: 'abcd-2345' });
    // single use
    expect(() => call(stranger, mod.claimMachine, { code: 'ABCD2345' })).toThrow(/isn't valid/);

    expect(view(website, mod.myMachines).map(m => m.name)).toEqual(['lola-mbp']);
    expect(view(website, mod.myConns).map(c => c.process)).toEqual(['curl']);
    expect(view(website, mod.myEndpoints).map(e => e.ip)).toEqual(['151.101.64.81']);
    expect(view(website, mod.myRoutes)).toHaveLength(1);
    expect(view(website, mod.myChunks)).toHaveLength(1);
    expect(view(website, mod.myTraffic)).toHaveLength(1);
    expect(view(website, mod.myRollups)).toHaveLength(1); // live too, for the overview's last minutes
    expect(view(website, mod.myProcUsage).map(p => p.pid)).toEqual([4242]);
    expect(view(website, mod.myProcs)).toHaveLength(2);
    expect(view(stranger, mod.myProcs)).toEqual([]);
    expect(view(stranger, mod.myConns)).toEqual([]);
    expect(view(stranger, mod.myProcUsage)).toEqual([]);
    expect(view(stranger, mod.myChunks)).toEqual([]);

    // a stranger can't point their watch at someone else's machine
    const machineId = view(website, mod.myMachines)[0].id;
    expect(() => call(stranger, mod.watchMachine, { machineId, fromUs: 0n, toUs: 0n, overviewFromUs: 0n })).toThrow(
      /haven't paired/
    );

    // codes run out
    clock.set(new Timestamp(START + 20n * MINUTE));
    call(agent, mod.setPairCode, { code: 'QWER2345' });
    clock.set(new Timestamp(START + 31n * MINUTE));
    expect(() => call(stranger, mod.claimMachine, { code: 'QWER2345' })).toThrow(/isn't valid/);
  });

  it('keeps live packets for 30 seconds, and replays older ones', () => {
    const { clock, agent, website, call, view } = setup();
    call(agent, mod.registerMachine, { name: 'm', iface: 'en0' });
    call(agent, mod.ingest, { batch: batch(START) });
    call(agent, mod.setPairCode, { code: 'ABCD2345' });
    call(website, mod.claimMachine, { code: 'ABCD2345' });

    clock.set(new Timestamp(START + 2n * MINUTE));
    call(agent, mod.ingest, { batch: batch(START + 2n * MINUTE) });
    // the first batch's packets have aged out of the live view
    expect(view(website, mod.myChunks).map(c => c.t0Us)).toEqual([START + 2n * MINUTE - 1000n]);

    // but a replay of that minute still has them
    const machineId = view(website, mod.myMachines)[0].id;
    call(website, mod.watchMachine, { machineId, fromUs: START - MINUTE, toUs: START + MINUTE, overviewFromUs: 0n });
    expect(view(website, mod.myChunks).map(c => c.t0Us)).toEqual([START - 1000n]);
    expect(view(website, mod.myRollups)).toHaveLength(1);
  });

  it('prunes on schedule', () => {
    const { h, clock, agent, call } = setup();
    call(agent, mod.registerMachine, { name: 'm', iface: 'en0' });
    call(agent, mod.ingest, { batch: batch(START) });
    clock.set(new Timestamp(START + 25n * 60n * MINUTE));
    h.withReducerTx(TestAuth.internal(), ctx => mod.prune(ctx, { arg: { scheduledId: 0n, scheduledAt: { tag: 'Interval', value: { __time_duration_micros__: 0n } } as any } }));
    expect([...h.db.packetChunk.iter()]).toHaveLength(0); // older than a day
    expect([...h.db.liveChunk.iter()]).toHaveLength(0);
    expect([...h.db.procUsage.iter()]).toHaveLength(0);
    expect([...h.db.proc.iter()]).toHaveLength(0);
    expect([...h.db.conn.iter()]).toHaveLength(1); // kept for 30
  });

  it('lets the agent unpair everyone', () => {
    const { agent, website, stranger, call, view } = setup();
    call(agent, mod.registerMachine, { name: 'm', iface: 'en0' });
    call(agent, mod.ingest, { batch: batch(START) });
    call(agent, mod.setPairCode, { code: 'ABCD2345' });
    call(website, mod.claimMachine, { code: 'ABCD2345' });
    expect(view(website, mod.myConns)).toHaveLength(1);
    call(agent, mod.revokeViewers, {});
    expect(view(website, mod.myMachines)).toEqual([]);
    expect(view(website, mod.myConns)).toEqual([]);
    // and a code that's still out there doesn't let anyone back in
    call(agent, mod.setPairCode, { code: 'WXYZ6789' });
    call(agent, mod.revokeViewers, {});
    expect(() => call(stranger, mod.claimMachine, { code: 'WXYZ6789' })).toThrow(/isn't valid/);
  });
});
