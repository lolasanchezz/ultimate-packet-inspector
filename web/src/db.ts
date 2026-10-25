// the connection to SpacetimeDB. everything the site shows comes from the
// module's views, which only ever hold the machine (and time window) this
// browser is watching - the only file that touches the generated bindings
import type {Identity} from 'spacetimedb';
import {DbConnection, tables} from './module_bindings';

// each view's row type, read off the generated tables rather than imported by
// name - so this keeps working whatever `npm run generate` decides to call them
type RowOf<T> = T extends {iter(): Iterable<infer R>} ? R : never;
type Views = DbConnection['db'];
export type Machine = RowOf<Views['myMachines']>;
export type Watch = RowOf<Views['myWatch']>;
export type Conn = RowOf<Views['myConns']>;
export type Endpoint = RowOf<Views['myEndpoints']>;
export type Route = RowOf<Views['myRoutes']>;
export type PacketChunk = RowOf<Views['myChunks']>;
export type Rollup = RowOf<Views['myRollups']>;
export type Traffic = RowOf<Views['myTraffic']>;
export type ProcUsage = RowOf<Views['myProcUsage']>;
export type ProcRow = RowOf<Views['myProcs']>;

export type Status = {state: 'connecting' | 'connected' | 'offline' | 'error'; message?: string};

// this browser's identity, one per server: a token's no good anywhere else, and
// sending it anywhere else - a pairing link can name any server - would hand that
// server the identity
const tokenKey = (uri: string) => `upi.token ${uri}`;

function storedToken(uri: string): string | undefined {
    try {
        // from before they were kept by server - it can only be the built-in one's
        const old = uri === import.meta.env.UPI_SERVER ? localStorage.getItem('upi.token') : null;
        return localStorage.getItem(tokenKey(uri)) ?? old ?? undefined;
    } catch {
        return undefined; // private window, blocked storage - a fresh identity each time
    }
}

function storeToken(uri: string, token: string) {
    try {
        localStorage.setItem(tokenKey(uri), token);
    } catch {
        // see storedToken
    }
}

export class Db {
    conn: DbConnection;
    identity?: Identity;
    status: Status = {state: 'connecting'};
    ready = false; // the first subscription's in
    #listeners = new Set<() => void>();

    constructor(uri: string, database: string) {
        this.conn = DbConnection.builder()
            .withUri(uri)
            .withDatabaseName(database)
            .withToken(storedToken(uri))
            .withAutomaticReconnect()
            .onConnect((conn, identity, token) => {
                this.identity = identity;
                storeToken(uri, token);
                this.#setStatus({state: 'connected'});
                conn.subscriptionBuilder()
                    .onApplied(() => {
                        this.ready = true;
                        this.#changed();
                    })
                    .onError(ctx => this.#setStatus({state: 'error', message: ctx.event?.message ?? 'subscription failed'}))
                    .subscribe([
                        tables.myMachines,
                        tables.myWatch,
                        tables.myConns,
                        tables.myEndpoints,
                        tables.myRoutes,
                        tables.myChunks,
                        tables.myRollups,
                        tables.myTraffic,
                        tables.myProcUsage,
                        tables.myProcs,
                    ]);
            })
            .onAutomaticReconnect((_conn, identity, token) => {
                this.identity = identity;
                storeToken(uri, token);
                this.#setStatus({state: 'connected'});
            })
            .onDisconnect(() => this.#setStatus({state: 'offline'}))
            .onConnectError((_ctx, err) =>
                this.#setStatus({state: 'error', message: /websocket/i.test(err.message) ? `can't reach ${database} on ${uri}` : err.message}),
            )
            .build();

        const db = this.conn.db;
        for (const t of [db.myMachines, db.myWatch, db.myConns, db.myEndpoints, db.myRoutes, db.myChunks, db.myRollups, db.myTraffic, db.myProcUsage, db.myProcs]) {
            t.onInsert(() => this.#changed());
            t.onDelete(() => this.#changed());
            t.onUpdate?.(() => this.#changed());
        }
    }

    onChange(fn: () => void): () => void {
        this.#listeners.add(fn);
        return () => this.#listeners.delete(fn);
    }

    // a burst of row events is one change
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

    machines = (): Machine[] => [...this.conn.db.myMachines.iter()];
    watch = (): Watch | undefined => this.conn.db.myWatch.iter().next().value ?? undefined;
    conns = (): Conn[] => [...this.conn.db.myConns.iter()];
    endpoints = (): Endpoint[] => [...this.conn.db.myEndpoints.iter()];
    routes = (): Route[] => [...this.conn.db.myRoutes.iter()];
    chunks = (): PacketChunk[] => [...this.conn.db.myChunks.iter()];
    rollups = (): Rollup[] => [...this.conn.db.myRollups.iter()];
    traffic = (): Traffic[] => [...this.conn.db.myTraffic.iter()];
    procUsage = (): ProcUsage[] => [...this.conn.db.myProcUsage.iter()];
    procs = (): ProcRow[] => [...this.conn.db.myProcs.iter()];

    claim = (code: string) => this.conn.reducers.claimMachine({code});
    forget = (machineId: number) => this.conn.reducers.forgetMachine({machineId});
    setWatch = (machineId: number, fromMs: number, toMs: number, overviewFromMs: number) =>
        this.conn.reducers.watchMachine({
            machineId,
            fromUs: BigInt(Math.round(fromMs)) * 1000n,
            toUs: BigInt(Math.round(toMs)) * 1000n,
            overviewFromUs: BigInt(Math.round(overviewFromMs)) * 1000n,
        });
}

export const ms = (us: bigint) => Number(us / 1000n);
