// the SpacetimeDB side. agents push batches into private tables with `ingest`;
// websites pair with a machine using a code from `upi pair`, then see only that
// machine's data, through the views at the bottom
import { Range, ScheduleAt, SenderError, schema, t, table } from 'spacetimedb/server';
import type { InferSchema, ReadonlyDbView, ReducerCtx } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';

const SECOND = 1_000_000n; // timestamps are microseconds since the epoch
const MINUTE = 60n * SECOND;
const HOUR = 60n * MINUTE;
const DAY = 24n * HOUR;

const LIVE_CHUNKS_FOR = 30n * SECOND; // how far back the live view's packets go
const CHUNKS_FOR = DAY; // every packet header is kept this long
const HISTORY_FOR = 30n * DAY; // connections, endpoints, routes, rollups
const PAIR_CODE_FOR = 10n * MINUTE;
const MAX_REPLAY = 10n * MINUTE; // of packets at once - beyond that the website uses rollups
const MAX_ROLLUP_WINDOW = 6n * HOUR;
const MAX_LIVE_WINDOW = DAY + 2n * HOUR; // the website's longest period, a day, and a little

// --- tables. none are public: everything a website sees goes through a view ---

const machine = table(
  { name: 'machine' },
  {
    id: t.u32().primaryKey().autoInc(),
    agent: t.identity().unique(), // the agent's own identity - only it can push
    name: t.string(),
    iface: t.string(),
    homeLat: t.f64(),
    homeLon: t.f64(),
    homePlace: t.string(),
    lastSeenUs: t.u64(),
    pps: t.f64(),
    dropped: t.u64(),
    nstat: t.bool(), // flow events are working (vs socket scans)
    geo: t.bool(), // the agent has its geo databases
    sampled: t.u32(), // 1 in this many packets is being recorded
    // the last batch's time (the agent's clock) - the same batch again is one the
    // agent retried after it had already gone in, so it's skipped
    lastBatchUs: t.u64().default(0n),
  }
);

const viewer = table(
  { name: 'viewer' },
  {
    id: t.u64().primaryKey().autoInc(),
    machineId: t.u32().index('btree'),
    identity: t.identity().index('btree'),
    addedUs: t.u64(),
  }
);

const pairCode = table(
  { name: 'pair_code' },
  {
    code: t.string().primaryKey(),
    machineId: t.u32().index('btree'),
    expiresUs: t.u64(),
  }
);

// what each website is looking at: one machine, live or a window in the past.
// the views read it, so changing it is how the website moves through time
const watch = table(
  { name: 'watch' },
  {
    identity: t.identity().primaryKey(),
    machineId: t.u32(),
    fromUs: t.u64(), // connections + endpoints active since then
    toUs: t.u64(), // 0 = live
    overviewFromUs: t.u64(), // the timeline's per-minute traffic starts here
  }
);

// one process talking to one remote address + port
const conn = table(
  {
    name: 'conn',
    indexes: [{ accessor: 'byMachineLast', algorithm: 'btree', columns: ['machineId', 'lastUs'] }],
  },
  {
    key: t.string().primaryKey(), // machine/conn id
    machineId: t.u32(),
    connId: t.u64(),
    pid: t.i32(), // -1 for system traffic, 0 when it couldn't be matched
    process: t.string(),
    proto: t.u8(),
    remoteIp: t.string(),
    remotePort: t.u16(),
    localPort: t.u16(),
    host: t.string(),
    firstUs: t.u64(),
    lastUs: t.u64(),
    bytesUp: t.f64(),
    bytesDown: t.f64(),
    pktsUp: t.f64(),
    pktsDown: t.f64(),
    rttMs: t.f64(),
    open: t.bool(),
    plaintext: t.bool(),
    system: t.bool(),
  }
);

// everything known about one remote address
const endpoint = table(
  {
    name: 'endpoint',
    indexes: [{ accessor: 'byMachineLast', algorithm: 'btree', columns: ['machineId', 'lastUs'] }],
  },
  {
    key: t.string().primaryKey(), // machine/ip
    machineId: t.u32(),
    ip: t.string(),
    kind: t.string(), // public, lan, loopback, cgnat, multicast, unknown
    host: t.string(),
    ptr: t.string(),
    lat: t.f64(),
    lon: t.f64(),
    located: t.bool(),
    city: t.string(),
    region: t.string(),
    country: t.string(),
    countryCode: t.string(),
    asn: t.u32(),
    org: t.string(),
    owner: t.string(),
    categories: t.array(t.string()),
    tracker: t.bool(),
    rttMs: t.f64(),
    possible: t.bool(), // whether the geo-ip location fits the round trip time
    drawnLat: t.f64(), // where to draw it - moved when it's impossible
    drawnLon: t.f64(),
    route: t.string(),
    lastUs: t.u64(),
  }
);

// one traced path from a machine, shared by every address in the prefix
const route = table(
  {
    name: 'route',
    indexes: [{ accessor: 'byMachineTraced', algorithm: 'btree', columns: ['machineId', 'tracedUs'] }],
  },
  {
    key: t.string().primaryKey(), // machine/prefix
    machineId: t.u32(),
    prefix: t.string(),
    dst: t.string(),
    tracedUs: t.u64(),
    hops: t.string(), // json - see agent/upload/batch.go's Hop
  }
);

// one connection's packet headers over one batch, 8 bytes a packet in base64 -
// the format's in agent/upload/batch.go
const chunkColumns = {
  id: t.u64().primaryKey().autoInc(),
  machineId: t.u32(),
  connId: t.u64(),
  t0Us: t.u64(),
  n: t.u32(),
  weight: t.u32(), // each recorded packet stands for this many
  data: t.string(),
};
const chunkIndexes = [{ accessor: 'byMachineTime', algorithm: 'btree', columns: ['machineId', 't0Us'] }] as const;
const packetChunk = table({ name: 'packet_chunk', indexes: [...chunkIndexes] }, chunkColumns);
// the same, for only the last LIVE_CHUNKS_FOR - what the live view subscribes to
const liveChunk = table({ name: 'live_chunk', indexes: [...chunkIndexes] }, { ...chunkColumns });

// a connection's bytes per minute, for looking further back than packets are kept
const rollup = table(
  {
    name: 'rollup',
    indexes: [{ accessor: 'byMachineMinute', algorithm: 'btree', columns: ['machineId', 'minuteUs'] }],
  },
  {
    key: t.string().primaryKey(), // machine/conn/minute
    machineId: t.u32(),
    connId: t.u64(),
    minuteUs: t.u64(),
    bytesUp: t.f64(),
    bytesDown: t.f64(),
    pkts: t.f64(),
    pktsUp: t.f64().default(0), // of pkts, the ones sent - added later, so older rows have 0
  }
);

// the whole machine's traffic per minute, for the timeline
const traffic = table(
  {
    name: 'traffic',
    indexes: [{ accessor: 'byMachineMinute', algorithm: 'btree', columns: ['machineId', 'minuteUs'] }],
  },
  {
    key: t.string().primaryKey(), // machine/minute
    machineId: t.u32(),
    minuteUs: t.u64(),
    bytesUp: t.f64(),
    bytesDown: t.f64(),
    pkts: t.f64(),
  }
);

// what each process with a connection costs the machine, per minute - only the
// agent's own user's processes; root's won't say
const procUsage = table(
  {
    name: 'proc_usage',
    indexes: [{ accessor: 'byMachineMinute', algorithm: 'btree', columns: ['machineId', 'minuteUs'] }],
  },
  {
    key: t.string().primaryKey(), // machine/pid/minute
    machineId: t.u32(),
    pid: t.i32(),
    process: t.string(),
    minuteUs: t.u64(),
    cpuMs: t.f64(), // cpu time used in the minute, across every core
    memBytes: t.f64(), // the most memory it had (its footprint, like activity monitor's)
    diskBytes: t.f64(), // read + written
  }
);

// when each process with a connection started - every process, root's too
const proc = table(
  {
    name: 'proc',
    indexes: [{ accessor: 'byMachineLast', algorithm: 'btree', columns: ['machineId', 'lastUs'] }],
  },
  {
    key: t.string().primaryKey(), // machine/pid
    machineId: t.u32(),
    pid: t.i32(),
    process: t.string(),
    startUs: t.u64(),
    lastUs: t.u64(), // when the agent last said anything about it
  }
);

const pruneJob = table(
  { name: 'prune_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({
  machine,
  viewer,
  pairCode,
  watch,
  conn,
  endpoint,
  route,
  packetChunk,
  liveChunk,
  rollup,
  traffic,
  procUsage,
  proc,
  pruneJob,
});
export default spacetimedb;

type S = InferSchema<typeof spacetimedb>;
type Ctx = ReducerCtx<S>;
type ReadDb = ReadonlyDbView<S>;

const since = (from: bigint) => new Range<bigint>({ tag: 'included', value: from }, { tag: 'unbounded' });
const between = (from: bigint, to: bigint) =>
  new Range<bigint>({ tag: 'included', value: from }, { tag: 'included', value: to });
const before = (to: bigint) => new Range<bigint>({ tag: 'unbounded' }, { tag: 'excluded', value: to });

// json numbers -> u64 columns
const u64 = (n: unknown) => BigInt(Math.max(0, Math.trunc(Number(n) || 0)));
const str = (s: unknown, max = 512) => (typeof s === 'string' ? s.slice(0, max) : '');
const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

function agentMachine(ctx: Ctx) {
  const m = ctx.db.machine.agent.find(ctx.sender);
  if (!m) throw new SenderError('this identity has no machine - run `upi run` once to register it');
  return m;
}

function isViewer(db: ReadDb, who: Identity, machineId: number) {
  for (const v of db.viewer.identity.filter(who)) {
    if (v.machineId === machineId) return true;
  }
  return false;
}

export const init = spacetimedb.init(ctx => {
  ctx.db.pruneJob.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(5n * MINUTE) });
});

// --- reducers the agent calls ---

export const registerMachine = spacetimedb.reducer({ name: t.string(), iface: t.string() }, (ctx, { name, iface }) => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const m = ctx.db.machine.agent.find(ctx.sender);
  if (m) {
    ctx.db.machine.id.update({ ...m, name: str(name, 64), iface: str(iface, 32), lastSeenUs: now });
    return;
  }
  ctx.db.machine.insert({
    id: 0,
    agent: ctx.sender,
    name: str(name, 64) || 'a machine',
    iface: str(iface, 32),
    homeLat: 0,
    homeLon: 0,
    homePlace: '',
    lastSeenUs: now,
    pps: 0,
    dropped: 0n,
    nstat: false,
    geo: false,
    sampled: 1,
    lastBatchUs: 0n,
  });
});

// a one-time code for pairing a website - `upi pair` makes it, the website claims it
export const setPairCode = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const m = agentMachine(ctx);
  code = normalizeCode(code);
  if (code.length < 8) throw new SenderError('pairing codes are 8 characters');
  ctx.db.pairCode.machineId.delete(m.id); // one at a time
  ctx.db.pairCode.insert({ code, machineId: m.id, expiresUs: ctx.timestamp.microsSinceUnixEpoch + PAIR_CODE_FOR });
});

export const revokeViewers = spacetimedb.reducer(ctx => {
  const m = agentMachine(ctx);
  ctx.db.pairCode.machineId.delete(m.id); // a code that's out there would let someone straight back in
  for (const v of [...ctx.db.viewer.machineId.filter(m.id)]) {
    ctx.db.viewer.id.delete(v.id);
    const w = ctx.db.watch.identity.find(v.identity);
    if (w?.machineId === m.id) ctx.db.watch.identity.delete(v.identity);
  }
});

type Batch = {
  t: number;
  stats?: { iface?: string; pps?: number; dropped?: number; nstat?: boolean; geo?: boolean; sampled?: number };
  home?: { lat: number; lon: number; place: string };
  conns?: any[];
  endpoints?: any[];
  routes?: any[];
  chunks?: any[];
  procs?: any[];
};

// everything that changed on a machine since the last batch. it comes as a json
// string so the agent (plain go + http, no sdk) only has to speak json
export const ingest = spacetimedb.reducer({ batch: t.string() }, (ctx, { batch }) => {
  const m = agentMachine(ctx);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  let b: Batch;
  try {
    b = JSON.parse(batch);
  } catch {
    throw new SenderError('batch is not json');
  }
  const mid = m.id;
  const t = u64(b.t);
  if (t !== 0n && t === m.lastBatchUs) return;

  const s = b.stats ?? {};
  ctx.db.machine.id.update({
    ...m,
    lastSeenUs: now,
    lastBatchUs: t,
    iface: str(s.iface, 32) || m.iface,
    pps: num(s.pps),
    dropped: u64(s.dropped),
    nstat: !!s.nstat,
    geo: !!s.geo,
    sampled: Math.max(1, Math.trunc(num(s.sampled))),
    ...(b.home ? { homeLat: num(b.home.lat), homeLon: num(b.home.lon), homePlace: str(b.home.place, 128) } : {}),
  });

  const minute = (u64(b.t) / MINUTE) * MINUTE;
  let up = 0,
    down = 0,
    pkts = 0;
  for (const c of b.conns ?? []) {
    const row = {
      key: `${mid}/${c.id}`,
      machineId: mid,
      connId: u64(c.id),
      pid: Math.trunc(num(c.pid)),
      process: str(c.process, 128),
      proto: Math.trunc(num(c.proto)) & 0xff,
      remoteIp: str(c.remoteIp, 64),
      remotePort: Math.trunc(num(c.remotePort)) & 0xffff,
      localPort: Math.trunc(num(c.localPort)) & 0xffff,
      host: str(c.host, 256),
      firstUs: u64(c.firstUs),
      lastUs: u64(c.lastUs),
      bytesUp: num(c.bytesUp),
      bytesDown: num(c.bytesDown),
      pktsUp: num(c.pktsUp),
      pktsDown: num(c.pktsDown),
      rttMs: num(c.rttMs),
      open: !!c.open,
      plaintext: !!c.plaintext,
      system: !!c.system,
    };
    if (ctx.db.conn.key.find(row.key)) ctx.db.conn.key.update(row);
    else ctx.db.conn.insert(row);

    // keep the endpoint showing as long as something's talking to it
    const ep = ctx.db.endpoint.key.find(`${mid}/${row.remoteIp}`);
    if (ep && ep.lastUs < row.lastUs) ctx.db.endpoint.key.update({ ...ep, lastUs: row.lastUs });

    const dUp = num(c.dUp),
      dDown = num(c.dDown),
      dPkts = num(c.dPkts);
    if (dUp + dDown + dPkts > 0) {
      addRollup(ctx, mid, row.connId, minute, dUp, dDown, dPkts, num(c.dPktsUp));
      up += dUp;
      down += dDown;
      pkts += dPkts;
    }
  }
  if (up + down + pkts > 0) {
    const key = `${mid}/${minute}`;
    const tr = ctx.db.traffic.key.find(key);
    if (tr) ctx.db.traffic.key.update({ ...tr, bytesUp: tr.bytesUp + up, bytesDown: tr.bytesDown + down, pkts: tr.pkts + pkts });
    else ctx.db.traffic.insert({ key, machineId: mid, minuteUs: minute, bytesUp: up, bytesDown: down, pkts });
  }

  for (const p of b.procs ?? []) {
    const pid = Math.trunc(num(p.pid));
    if (pid <= 0) continue;
    const startUs = u64(p.startUs);
    if (startUs > 0n) {
      const row = { key: `${mid}/${pid}`, machineId: mid, pid, process: str(p.process, 128), startUs, lastUs: u64(b.t) };
      if (ctx.db.proc.key.find(row.key)) ctx.db.proc.key.update(row);
      else ctx.db.proc.insert(row);
    }
    // agents from before `measured` only sent the ones they could measure
    if (p.measured === false) continue;
    const key = `${mid}/${pid}/${minute}`;
    const cpuMs = num(p.cpuMs),
      memBytes = num(p.mem),
      diskBytes = num(p.disk);
    const r = ctx.db.procUsage.key.find(key);
    if (r) ctx.db.procUsage.key.update({ ...r, cpuMs: r.cpuMs + cpuMs, memBytes: Math.max(r.memBytes, memBytes), diskBytes: r.diskBytes + diskBytes });
    else ctx.db.procUsage.insert({ key, machineId: mid, pid, process: str(p.process, 128), minuteUs: minute, cpuMs, memBytes, diskBytes });
  }

  for (const e of b.endpoints ?? []) {
    const ip = str(e.ip, 64);
    const key = `${mid}/${ip}`;
    const old = ctx.db.endpoint.key.find(key);
    const row = {
      key,
      machineId: mid,
      ip,
      kind: str(e.kind, 16),
      host: str(e.host, 256),
      ptr: str(e.ptr, 256),
      lat: num(e.lat),
      lon: num(e.lon),
      located: !!e.located,
      city: str(e.city, 128),
      region: str(e.region, 128),
      country: str(e.country, 128),
      countryCode: str(e.countryCode, 4),
      asn: Math.trunc(num(e.asn)) >>> 0,
      org: str(e.org, 256),
      owner: str(e.owner, 256),
      categories: Array.isArray(e.categories) ? e.categories.slice(0, 32).map((c: unknown) => str(c, 64)) : [],
      tracker: !!e.tracker,
      rttMs: num(e.rttMs),
      possible: e.possible !== false,
      drawnLat: num(e.drawnLat),
      drawnLon: num(e.drawnLon),
      route: str(e.route, 64),
      lastUs: old && old.lastUs > u64(b.t) ? old.lastUs : u64(b.t),
    };
    if (old) ctx.db.endpoint.key.update(row);
    else ctx.db.endpoint.insert(row);
  }

  for (const r of b.routes ?? []) {
    const prefix = str(r.prefix, 64);
    const row = {
      key: `${mid}/${prefix}`,
      machineId: mid,
      prefix,
      dst: str(r.dst, 64),
      tracedUs: u64(r.tracedUs),
      hops: JSON.stringify(Array.isArray(r.hops) ? r.hops.slice(0, 64) : []),
    };
    if (ctx.db.route.key.find(row.key)) ctx.db.route.key.update(row);
    else ctx.db.route.insert(row);
  }

  for (const c of b.chunks ?? []) {
    const row = {
      id: 0n,
      machineId: mid,
      connId: u64(c.conn),
      t0Us: u64(c.t0),
      n: Math.trunc(num(c.n)) >>> 0,
      weight: Math.max(1, Math.trunc(num(c.w))),
      data: str(c.data, 1 << 20),
    };
    ctx.db.packetChunk.insert(row);
    ctx.db.liveChunk.insert(row);
  }
  ctx.db.liveChunk.byMachineTime.delete([mid, before(now - LIVE_CHUNKS_FOR)]);
});

function addRollup(ctx: Ctx, mid: number, connId: bigint, minute: bigint, up: number, down: number, pkts: number, pktsUp: number) {
  const key = `${mid}/${connId}/${minute}`;
  const r = ctx.db.rollup.key.find(key);
  if (r) ctx.db.rollup.key.update({ ...r, bytesUp: r.bytesUp + up, bytesDown: r.bytesDown + down, pkts: r.pkts + pkts, pktsUp: r.pktsUp + pktsUp });
  else ctx.db.rollup.insert({ key, machineId: mid, connId, minuteUs: minute, bytesUp: up, bytesDown: down, pkts, pktsUp });
}

// --- reducers the website calls ---

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const claimMachine = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const pc = ctx.db.pairCode.code.find(normalizeCode(code));
  if (!pc || pc.expiresUs < now) throw new SenderError("that code isn't valid - run `upi pair` for a fresh one");
  ctx.db.pairCode.code.delete(pc.code);
  if (!isViewer(ctx.db, ctx.sender, pc.machineId)) {
    ctx.db.viewer.insert({ id: 0n, machineId: pc.machineId, identity: ctx.sender, addedUs: now });
  }
  setWatch(ctx, pc.machineId, now - 15n * MINUTE, 0n, now - DAY);
});

export const forgetMachine = spacetimedb.reducer({ machineId: t.u32() }, (ctx, { machineId }) => {
  for (const v of [...ctx.db.viewer.identity.filter(ctx.sender)]) {
    if (v.machineId === machineId) ctx.db.viewer.id.delete(v.id);
  }
  if (ctx.db.watch.identity.find(ctx.sender)?.machineId === machineId) ctx.db.watch.identity.delete(ctx.sender);
});

// picks the machine + window the views show. toUs = 0 is live; anything else is a
// replay, kept short enough that a subscription can't pull a day of packets
export const watchMachine = spacetimedb.reducer(
  { machineId: t.u32(), fromUs: t.u64(), toUs: t.u64(), overviewFromUs: t.u64() },
  (ctx, { machineId, fromUs, toUs, overviewFromUs }) => {
    if (!isViewer(ctx.db, ctx.sender, machineId)) throw new SenderError("you haven't paired with that machine");
    setWatch(ctx, machineId, fromUs, toUs, overviewFromUs);
  }
);

function setWatch(ctx: Ctx, machineId: number, fromUs: bigint, toUs: bigint, overviewFromUs: bigint) {
  if (toUs !== 0n && toUs < fromUs) [fromUs, toUs] = [toUs, fromUs];
  // live, the views give everything since fromUs - so not further back than the
  // website ever needs
  const earliest = ctx.timestamp.microsSinceUnixEpoch - MAX_LIVE_WINDOW;
  if (toUs === 0n && fromUs < earliest) fromUs = earliest;
  if (overviewFromUs < earliest) overviewFromUs = earliest;
  const row = { identity: ctx.sender, machineId, fromUs, toUs, overviewFromUs };
  if (ctx.db.watch.identity.find(ctx.sender)) ctx.db.watch.identity.update(row);
  else ctx.db.watch.insert(row);
}

// --- housekeeping ---

export const prune = spacetimedb.reducer({ onSchedule: pruneJob }, { arg: pruneJob.rowType }, ctx => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const pc of [...ctx.db.pairCode.iter()]) {
    if (pc.expiresUs < now) ctx.db.pairCode.code.delete(pc.code);
  }
  for (const m of ctx.db.machine.iter()) {
    ctx.db.liveChunk.byMachineTime.delete([m.id, before(now - LIVE_CHUNKS_FOR)]);
    ctx.db.packetChunk.byMachineTime.delete([m.id, before(now - CHUNKS_FOR)]);
    ctx.db.rollup.byMachineMinute.delete([m.id, before(now - HISTORY_FOR)]);
    ctx.db.traffic.byMachineMinute.delete([m.id, before(now - HISTORY_FOR)]);
    ctx.db.procUsage.byMachineMinute.delete([m.id, before(now - CHUNKS_FOR)]);
    ctx.db.proc.byMachineLast.delete([m.id, before(now - CHUNKS_FOR)]);
    ctx.db.conn.byMachineLast.delete([m.id, before(now - HISTORY_FOR)]);
    ctx.db.endpoint.byMachineLast.delete([m.id, before(now - HISTORY_FOR)]);
    ctx.db.route.byMachineTraced.delete([m.id, before(now - HISTORY_FOR)]);
  }
});

// --- views: all a website can see is the machines it's paired with ---

type ViewCtx = { sender: Identity; db: ReadDb };

// the sender's watch row, if they're still allowed to see that machine
function watching(ctx: ViewCtx) {
  const w = ctx.db.watch.identity.find(ctx.sender);
  return w && isViewer(ctx.db, ctx.sender, w.machineId) ? w : undefined;
}

export const myMachines = spacetimedb.view({ name: 'my_machines', public: true }, t.array(machine.rowType), ctx => {
  const out = [];
  for (const v of ctx.db.viewer.identity.filter(ctx.sender)) {
    const m = ctx.db.machine.id.find(v.machineId);
    if (m) out.push(m);
  }
  return out;
});

export const myWatch = spacetimedb.view({ name: 'my_watch', public: true }, t.option(watch.rowType), ctx => {
  return watching(ctx);
});

export const myConns = spacetimedb.view({ name: 'my_conns', public: true }, t.array(conn.rowType), ctx => {
  const w = watching(ctx);
  if (!w) return [];
  return [...ctx.db.conn.byMachineLast.filter([w.machineId, since(w.fromUs)])].filter(
    c => w.toUs === 0n || c.firstUs <= w.toUs
  );
});

export const myEndpoints = spacetimedb.view({ name: 'my_endpoints', public: true }, t.array(endpoint.rowType), ctx => {
  const w = watching(ctx);
  return w ? [...ctx.db.endpoint.byMachineLast.filter([w.machineId, since(w.fromUs)])] : [];
});

export const myRoutes = spacetimedb.view({ name: 'my_routes', public: true }, t.array(route.rowType), ctx => {
  const w = watching(ctx);
  // routes are traced every few hours, so one from a little before the window still applies
  return w ? [...ctx.db.route.byMachineTraced.filter([w.machineId, since(w.fromUs > 6n * HOUR ? w.fromUs - 6n * HOUR : 0n)])] : [];
});

export const myChunks = spacetimedb.view({ name: 'my_chunks', public: true }, t.array(packetChunk.rowType), ctx => {
  const w = watching(ctx);
  if (!w) return [];
  if (w.toUs === 0n) return [...ctx.db.liveChunk.byMachineTime.filter([w.machineId, new Range<bigint>()])];
  const from = w.toUs - w.fromUs > MAX_REPLAY ? w.toUs - MAX_REPLAY : w.fromUs;
  return [...ctx.db.packetChunk.byMachineTime.filter([w.machineId, between(from, w.toUs)])];
});

// a window in per-minute rows: live, everything since it started; a replay, up to
// MAX_ROLLUP_WINDOW of it
function minutes(w: { fromUs: bigint; toUs: bigint }) {
  if (w.toUs === 0n) return since(w.fromUs);
  return between(w.toUs - w.fromUs > MAX_ROLLUP_WINDOW ? w.toUs - MAX_ROLLUP_WINDOW : w.fromUs, w.toUs);
}

export const myRollups = spacetimedb.view({ name: 'my_rollups', public: true }, t.array(rollup.rowType), ctx => {
  const w = watching(ctx);
  return w ? [...ctx.db.rollup.byMachineMinute.filter([w.machineId, minutes(w)])] : [];
});

export const myProcs = spacetimedb.view({ name: 'my_procs', public: true }, t.array(proc.rowType), ctx => {
  const w = watching(ctx);
  return w ? [...ctx.db.proc.byMachineLast.filter([w.machineId, since(w.fromUs)])] : [];
});

export const myProcUsage = spacetimedb.view({ name: 'my_proc_usage', public: true }, t.array(procUsage.rowType), ctx => {
  const w = watching(ctx);
  return w ? [...ctx.db.procUsage.byMachineMinute.filter([w.machineId, minutes(w)])] : [];
});

export const myTraffic = spacetimedb.view({ name: 'my_traffic', public: true }, t.array(traffic.rowType), ctx => {
  const w = watching(ctx);
  return w ? [...ctx.db.traffic.byMachineMinute.filter([w.machineId, since(w.overviewFromUs)])] : [];
});
