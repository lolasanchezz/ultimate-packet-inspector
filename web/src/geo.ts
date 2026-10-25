// geometry on a sphere: great circles, the speed-of-light bound, and snapping
// ocean crossings onto the undersea cables they actually take

export type LonLat = [number, number];

const EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function distanceKm(a: LonLat, b: LonLat): number {
    const φ1 = rad(a[1]), φ2 = rad(b[1]);
    const dφ = φ2 - φ1, dλ = rad(b[0] - a[0]);
    const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// the point f of the way along the great circle from a to b
export function interpolate(a: LonLat, b: LonLat, f: number): LonLat {
    const δ = distanceKm(a, b) / EARTH_KM;
    if (δ === 0) return a;
    const φ1 = rad(a[1]), λ1 = rad(a[0]), φ2 = rad(b[1]), λ2 = rad(b[0]);
    const sa = Math.sin((1 - f) * δ) / Math.sin(δ), sb = Math.sin(f * δ) / Math.sin(δ);
    const x = sa * Math.cos(φ1) * Math.cos(λ1) + sb * Math.cos(φ2) * Math.cos(λ2);
    const y = sa * Math.cos(φ1) * Math.sin(λ1) + sb * Math.cos(φ2) * Math.sin(λ2);
    const z = sa * Math.sin(φ1) + sb * Math.sin(φ2);
    return [deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.hypot(x, y)))];
}

// a great circle as a polyline, a point every stepKm or so
export function greatCircle(a: LonLat, b: LonLat, stepKm = 150): LonLat[] {
    const n = Math.max(1, Math.ceil(distanceKm(a, b) / stepKm));
    const out: LonLat[] = [];
    for (let i = 0; i <= n; i++) out.push(interpolate(a, b, i / n));
    return out;
}

// longitudes that don't jump 360° crossing the date line, so a path across the
// pacific draws across the pacific (the map repeats the world either side)
export function unwrap(path: LonLat[]): LonLat[] {
    const out: LonLat[] = [];
    let shift = 0;
    for (let i = 0; i < path.length; i++) {
        if (i > 0) {
            const d = path[i][0] + shift - out[i - 1][0];
            if (d > 180) shift -= 360;
            else if (d < -180) shift += 360;
        }
        out.push([path[i][0] + shift, path[i][1]]);
    }
    return out;
}

// light in fiber covers ~200km per millisecond, so a round trip of r ms can't
// have gone further than r * 100 km - the same bound the agent checks with
export const KM_PER_RTT_MS = 100;
export const maxKm = (rttMs: number) => rttMs * KM_PER_RTT_MS;

// a ring km around p, for drawing "it has to be somewhere in here"
export function circle(p: LonLat, km: number, steps = 120): LonLat[] {
    const δ = km / EARTH_KM, φ1 = rad(p[1]), λ1 = rad(p[0]);
    const out: LonLat[] = [];
    for (let i = 0; i <= steps; i++) {
        const θ = (2 * Math.PI * i) / steps;
        const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
        const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
        out.push([deg(λ2), deg(φ2)]);
    }
    return unwrap(out);
}

// --- land, for telling an ocean crossing from a long way overland ---

type Ring = LonLat[];
type Polygon = {rings: Ring[]; minLon: number; maxLon: number; minLat: number; maxLat: number};

export class Land {
    #polygons: Polygon[];

    constructor(multipolygons: Ring[][]) {
        this.#polygons = multipolygons.map(rings => {
            const lons = rings[0].map(p => p[0]), lats = rings[0].map(p => p[1]);
            return {rings, minLon: Math.min(...lons), maxLon: Math.max(...lons), minLat: Math.min(...lats), maxLat: Math.max(...lats)};
        });
    }

    contains([lon, lat]: LonLat): boolean {
        lon = ((((lon + 180) % 360) + 360) % 360) - 180;
        // rings that cross the date line carry on past ±180, so try a world either side too
        for (const x of [lon, lon - 360, lon + 360]) {
            for (const p of this.#polygons) {
                if (x < p.minLon || x > p.maxLon || lat < p.minLat || lat > p.maxLat) continue;
                // inside the outline and outside every hole
                if (inRing(p.rings[0], x, lat) && !p.rings.slice(1).some(h => inRing(h, x, lat))) return true;
            }
        }
        return false;
    }

    // whether the great circle from a to b is mostly sea
    crossesWater(a: LonLat, b: LonLat): boolean {
        const samples = 9;
        let wet = 0;
        for (let i = 1; i <= samples; i++) {
            if (!this.contains(interpolate(a, b, i / (samples + 1)))) wet++;
        }
        return wet > samples / 2;
    }
}

function inRing(ring: Ring, x: number, y: number): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

// --- cables ---

export type Cable = {name: string; color: string; lines: LonLat[][]};

// how far a cable's end can be from a hop and still be the one it took - routers
// sit in cities, cables land on coasts
const CABLE_REACH_KM = 900;
// cables come in pieces - split at the date line and at branching units. pieces
// whose ends are this close are joined
const JOIN_KM = 30;

type Graph = {points: LonLat[]; edges: {to: number; km: number}[][]};
const graphs = new WeakMap<Cable, Graph>();

// a cable as one graph: every point, joined along each piece and wherever one
// piece's end touches another
function graphOf(cable: Cable): Graph {
    let g = graphs.get(cable);
    if (g) return g;
    const points: LonLat[] = [];
    const edges: {to: number; km: number}[][] = [];
    const link = (a: number, b: number) => {
        const km = distanceKm(points[a], points[b]);
        edges[a].push({to: b, km});
        edges[b].push({to: a, km});
    };
    const ends: number[] = [];
    for (const line of cable.lines) {
        const first = points.length;
        for (let i = 0; i < line.length; i++) {
            points.push(line[i]);
            edges.push([]);
            if (i > 0) link(first + i - 1, first + i);
        }
        ends.push(first, points.length - 1);
    }
    for (const e of ends) {
        for (let i = 0; i < points.length; i++) {
            if (i !== e && distanceKm(points[e], points[i]) < JOIN_KM && !edges[e].some(x => x.to === i)) link(e, i);
        }
    }
    g = {points, edges};
    graphs.set(cable, g);
    return g;
}

function nearest(points: LonLat[], p: LonLat): [number, number] {
    let best = -1, bestKm = Infinity;
    for (let i = 0; i < points.length; i++) {
        const km = distanceKm(points[i], p);
        if (km < bestKm) [best, bestKm] = [i, km];
    }
    return [best, bestKm];
}

// shortest way through the graph from one point to another, as coordinates
function shortest(g: Graph, from: number, to: number): {path: LonLat[]; km: number} | null {
    const dist = new Array<number>(g.points.length).fill(Infinity);
    const prev = new Array<number>(g.points.length).fill(-1);
    const done = new Array<boolean>(g.points.length).fill(false);
    dist[from] = 0;
    // the graphs are a few hundred points, so a linear scan for the next closest is fine
    for (;;) {
        let u = -1;
        for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
        if (u < 0) return null;
        if (u === to) break;
        done[u] = true;
        for (const {to: v, km} of g.edges[u]) {
            if (dist[u] + km < dist[v]) [dist[v], prev[v]] = [dist[u] + km, u];
        }
    }
    const path: LonLat[] = [];
    for (let v = to; v >= 0; v = prev[v]) path.unshift(g.points[v]);
    return {path, km: dist[to]};
}

// the stretch of cable that best joins a to b, or null if none comes near both
export function cableBetween(cables: Cable[], a: LonLat, b: LonLat): {cable: Cable; path: LonLat[]} | null {
    let best: {cable: Cable; path: LonLat[]; score: number} | null = null;
    for (const cable of cables) {
        // a cheap look first - most cables don't come anywhere near
        if (!cable.lines.some(l => l.some(p => distanceKm(p, a) < CABLE_REACH_KM))) continue;
        if (!cable.lines.some(l => l.some(p => distanceKm(p, b) < CABLE_REACH_KM))) continue;
        const g = graphOf(cable);
        const [ia, da] = nearest(g.points, a);
        const [ib, db] = nearest(g.points, b);
        if (ia === ib) continue;
        const found = shortest(g, ia, ib);
        if (!found) continue;
        // getting on + off counts, and so does the cable wandering far from the straight line
        const score = da + db + Math.max(0, found.km - distanceKm(a, b));
        if (!best || score < best.score) best = {cable, path: found.path, score};
    }
    return best && {cable: best.cable, path: best.path};
}
