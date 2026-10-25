// the line drawn from a machine to an endpoint: through every router on its traced
// route that has a believable location, along the undersea cable wherever a hop
// crosses an ocean, or a plain great circle when there's no route yet
import type {Feature, FeatureCollection} from 'geojson';
import {Land, cableBetween, distanceKm, greatCircle, maxKm, unwrap, type Cable, type LonLat} from './geo';

// one router on a route - see agent/upload/batch.go's Hop
export type Hop = {
    ttl: number;
    ip: string;
    rttMs: number;
    ptr: string;
    asn: number;
    org: string;
    lat: number;
    lon: number;
    located: boolean;
    city: string;
    country: string;
    from: string; // where its location came from: "geoip", or the code in its name
    possible: boolean;
};

export type Drawn = {
    path: LonLat[];
    legs: LonLat[][]; // the path cut at its routers - each one starts where the last ended
    fractions: number[]; // how far along the path each point is, 0 to 1 - for timing packets
    cables: string[]; // names of the cables it crosses
    stops: {at: LonLat; hop: Hop}[]; // the routers it goes through
    km: number;
};

export function parseHops(json: string): Hop[] {
    try {
        const hops = JSON.parse(json);
        return Array.isArray(hops) ? hops : [];
    } catch {
        return [];
    }
}

// world-atlas is made for spherical geometry, so rings that cross the date line
// (russia, fiji) jump from +180 to -180 - which flat point-in-polygon tests get
// wrong. unwrapping makes them carry on past 180 instead, and a ring that goes all
// the way round (antarctica) gets closed off down at the pole
export function flatRing(ring: LonLat[]): LonLat[] {
    const out = unwrap(ring);
    const first = out[0], last = out[out.length - 1];
    if (Math.abs(last[0] - first[0]) > 180) {
        const pole = out.reduce((a, p) => a + p[1], 0) < 0 ? -90 : 90;
        out.push([last[0], pole], [first[0], pole], first);
    }
    return out;
}

export function landRings(f: Feature | FeatureCollection): LonLat[][][] {
    const geoms = 'features' in f ? f.features.map(x => x.geometry) : [f.geometry];
    const out: LonLat[][][] = [];
    for (const g of geoms) {
        if (g.type === 'Polygon') out.push((g.coordinates as LonLat[][]).map(flatRing));
        else if (g.type === 'MultiPolygon') out.push(...(g.coordinates as LonLat[][][]).map(p => p.map(flatRing)));
    }
    return out;
}

// below this a hop's too close to the last stop to be worth a detour
const MIN_STOP_KM = 40;
// above this, a hop over water gets snapped to a cable
const OCEAN_KM = 1000;

type Stop = {at: LonLat; hop: Hop};

// how long the way out to end can be, given a round trip of rttMs: there and back
// is at most rttMs x 200km of fiber, and the way back is at least the straight line
export function routeLimitKm(home: LonLat, end: LonLat, rttMs: number): number {
    return rttMs > 0 ? 2 * maxKm(rttMs) - distanceKm(home, end) : Infinity;
}

// which routers a line goes through. each one's location already fits its own
// round trip, but a route as a whole can still be impossible - so geo-ip
// locations that send it out and straight back (a router listed at its owner's
// head office, usually) are dropped, then the biggest detours, until the whole
// route fits in the round trip to where it's going
export function chooseStops(home: LonLat, stops: Stop[], end: LonLat, limitKm: number): Stop[] {
    const kept = stops.slice();
    const before = (i: number) => (i > 0 ? kept[i - 1].at : home);
    const after = (i: number) => (i < kept.length - 1 ? kept[i + 1].at : end);
    // how much further the route goes for stopping at i
    const detour = (i: number) => distanceKm(before(i), kept[i].at) + distanceKm(kept[i].at, after(i)) - distanceKm(before(i), after(i));

    // dropping one can make its neighbour a spike, so round again until none are
    for (let found = true; found; ) {
        const i = kept.findIndex((s, i) => s.hop.from === 'geoip' && detour(i) > 0.5 * distanceKm(before(i), after(i)) + 300);
        found = i >= 0;
        if (found) kept.splice(i, 1);
    }
    const length = () => kept.reduce((km, s, i) => km + distanceKm(before(i), s.at), 0) + distanceKm(kept.length ? kept[kept.length - 1].at : home, end);
    while (kept.length && length() > limitKm) {
        let worst = 0;
        for (let i = 1; i < kept.length; i++) if (detour(i) > detour(worst)) worst = i;
        kept.splice(worst, 1);
    }
    return kept;
}

export class Router {
    #land: Land;
    #cables: Cable[];
    #cache = new Map<string, Drawn>();
    static readonly MAX_CACHED = 5000; // routes kept - past that it starts again, rather than keep every one ever drawn

    constructor(land: Land, cables: Cable[]) {
        this.#land = land;
        this.#cables = cables;
    }

    // key changes whenever the inputs do (a new trace, a moved endpoint, a quicker
    // round trip). rttMs is the endpoint's best - 0 if there isn't one yet
    path(key: string, home: LonLat, hops: Hop[], end: LonLat, rttMs = 0): Drawn {
        const cached = this.#cache.get(key);
        if (cached) return cached;

        const candidates: Stop[] = [];
        let prev = home;
        for (const hop of hops) {
            if (!hop.located || !hop.possible) continue;
            const at: LonLat = [hop.lon, hop.lat];
            if (distanceKm(at, prev) < MIN_STOP_KM) continue;
            candidates.push({at, hop});
            prev = at;
        }
        const stops = chooseStops(home, candidates, end, routeLimitKm(home, end, rttMs));
        const last = stops.length ? stops[stops.length - 1].at : home;

        const points = [home, ...stops.map(s => s.at)];
        if (distanceKm(end, last) >= MIN_STOP_KM || points.length === 1) points.push(end);
        const cables: string[] = [];
        let path: LonLat[] = [];
        const legEnds: number[] = [];
        for (let i = 1; i < points.length; i++) {
            const [a, b] = [points[i - 1], points[i]];
            let leg = greatCircle(a, b);
            if (distanceKm(a, b) > OCEAN_KM && this.#land.crossesWater(a, b)) {
                const found = cableBetween(this.#cables, a, b);
                if (found) {
                    leg = [...greatCircle(a, found.path[0]), ...found.path, ...greatCircle(found.path[found.path.length - 1], b)];
                    cables.push(found.cable.name);
                }
            }
            path = path.concat(i === 1 ? leg : leg.slice(1));
            legEnds.push(path.length - 1);
        }
        path = unwrap(path);
        const legs = legEnds.map((end, i) => path.slice(i ? legEnds[i - 1] : 0, end + 1));

        const dist = [0];
        for (let i = 1; i < path.length; i++) dist.push(dist[i - 1] + distanceKm(path[i - 1], path[i]));
        const km = dist[dist.length - 1] || 1;
        const drawn = {path, legs, fractions: dist.map(d => d / km), cables, stops, km};
        if (this.#cache.size >= Router.MAX_CACHED) this.#cache.clear();
        this.#cache.set(key, drawn);
        return drawn;
    }
}
