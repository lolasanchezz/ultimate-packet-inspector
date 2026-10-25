// the basemap: the world drawn in characters, live. every character on screen
// looks up the patch of ground under it, so zooming in brings out more detail
// instead of bigger letters. the source is one image `scripts/tif-to-ascii.py
// --png` exports from Natural Earth: red is brightness times how much of the
// pixel is land, green is how much of it is land
import {themeVar} from './theme';

// how it looks - its colours are in colors.css (--ascii-land, --ascii-border)
export const ASCII = {
    ramp: ' .:-=+*#%@', // sparse to dense - the first is never drawn
    opacity: 0.55, // under everything else, so the lines stay readable
    fontPx: 4, // smaller is finer - each character covers less ground
    lineHeight: 1.2,
    gamma: 1, // under 1 brightens the midtones, over 1 darkens them
    font: 'ui-monospace, Menlo, Consolas, monospace',
    // nothing's drawn south of this - the map's projection makes antarctica huge,
    // and nothing talks to it. -90 to bring it back
    minLat: -60,
    // country borders, traced through the grid in these - by which way the border runs
    borderOpacity: 0.7,
    // connections are traced the same way, in characters this many times the map's -
    // small enough to read as lines, and only look like characters up close
    lineScale: 1.5,
    // under the characters, a fine solid line so each connection reads as one -
    // how strong (0 for characters only) and how wide, in pixels
    lineUnderlay: 0.6,
    lineWidth: 1.25,
    // a connection that's gone quiet (no packets lately) is drawn thinner, in lighter
    // characters and without arrows
    quietLineWidth: 0.6,
};

// across, down, and the two diagonals - in the order borderChar picks them
const BORDER_CHARS = '-|/\\';
// the same for connections, and the mark where one ends
const LINE_CHARS = BORDER_CHARS + '*';
const LINE_END = 4;

// a connection (or a cable) to trace through the grid - lon, lat points. a
// connection's legs (its path cut at each router) let lines that share a stretch
// run side by side through it; key keeps each on the same side as things change
export type AsciiPath = {path: [number, number][]; legs?: [number, number][][]; key?: string; color: string; alpha: number; end?: boolean; quiet?: boolean};

// where lines share a stretch between two routers - or one line goes there and back -
// they run on their own parallel tracks, meeting again at the routers either end
export const TRACKS = {
    gap: 3, // px between neighbours
    spread: 15, // the widest a stretch fans out to, however many lines share it
    ease: 24, // px it takes to fan out after a router, and to come back in before the next
    // the chevrons that show which way a line's going: px between them, how far each
    // arm reaches back from the tip and out to the side, and how thick
    arrowsEvery: 110,
    arrowLength: 8,
    arrowSpread: 5.5,
    arrowWidth: 2,
};

// each leg's sideways shift in px, to the right of the way it's travelling (0 for
// a leg nothing else uses). legs are matched by the routers at their ends, either
// way round, so a line that doubles back on itself opens into a loop
export function tracks(paths: AsciiPath[]): number[][] {
    const at = (p: [number, number]) => `${((((p[0] + 180) % 360) + 360) % 360).toFixed(1)},${p[1].toFixed(1)}`;
    const stretches = new Map<string, {path: number; leg: number; flip: boolean}[]>();
    paths.forEach((p, i) =>
        p.legs?.forEach((leg, j) => {
            const a = at(leg[0]), b = at(leg[leg.length - 1]);
            if (a === b) return;
            const flip = a > b, key = flip ? `${b}|${a}` : `${a}|${b}`;
            const users = stretches.get(key) ?? [];
            users.push({path: i, leg: j, flip});
            stretches.set(key, users);
        }),
    );
    const out = paths.map(p => (p.legs ?? []).map(() => 0));
    for (const users of stretches.values()) {
        if (users.length < 2) continue;
        users.sort((x, y) => (paths[x.path].key ?? '').localeCompare(paths[y.path].key ?? '') || x.leg - y.leg);
        const gap = Math.min(TRACKS.gap, TRACKS.spread / (users.length - 1));
        users.forEach((u, i) => {
            const off = (i - (users.length - 1) / 2) * gap;
            // the same side of the stretch whichever way a leg runs along it
            out[u.path][u.leg] = u.flip ? -off : off;
        });
    }
    return out;
}

// a line on screen shifted off px to the right of the way it runs - easing in from
// its start and out to its end, so lines still meet where they meet
export function offsetLine(pts: [number, number][], off: number, ease = TRACKS.ease): [number, number][] {
    if (!off || pts.length < 2) return pts;
    const along = [0];
    for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = along[along.length - 1];
    return pts.map(([x, y], i) => {
        const [ax, ay] = pts[Math.max(0, i - 1)], [bx, by] = pts[Math.min(pts.length - 1, i + 1)];
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
        const k = off * Math.max(0, Math.min(1, along[i] / ease, (total - along[i]) / ease));
        // screen y runs down, so (-dy, dx) is to the right of (dx, dy)
        return [x - (dy / len) * k, y + (dx / len) * k];
    });
}

// a grid of the world, west to east from -180, north to south from 90
type Level = {w: number; h: number; cover: Uint8Array; lit: Uint8Array};

export type Pyramid = {
    levels: Level[]; // full size, then half, quarter... - each one averages the last
    lo: number; // the brightness range spread over the ramp - 1st to 99th percentile of land
    hi: number;
};

// a land share under this is water, and stays blank
const LAND = 128;

// rgba is the exported image's pixels, as canvas getImageData gives them
export function buildPyramid(w: number, h: number, rgba: Uint8ClampedArray): Pyramid {
    const cover = new Uint8Array(w * h), lit = new Uint8Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0; i < w * h; i++) {
        lit[i] = rgba[i * 4];
        cover[i] = rgba[i * 4 + 1];
        if (cover[i] >= LAND) hist[Math.min(255, Math.round((lit[i] * 255) / cover[i]))]++;
    }
    const levels: Level[] = [{w, h, cover, lit}];
    // averaging premultiplied brightness + land share keeps coasts honest: half-sea
    // pixels come out half-land, not as dark land
    for (let l = levels[0]; l.w > 1 && l.h > 1; l = levels[levels.length - 1]) {
        const nw = Math.ceil(l.w / 2), nh = Math.ceil(l.h / 2);
        const c = new Uint8Array(nw * nh), t = new Uint8Array(nw * nh);
        for (let y = 0; y < nh; y++) {
            const y0 = 2 * y, y1 = Math.min(2 * y + 1, l.h - 1);
            for (let x = 0; x < nw; x++) {
                const x0 = 2 * x, x1 = Math.min(2 * x + 1, l.w - 1);
                const a = y0 * l.w + x0, b = y0 * l.w + x1, d = y1 * l.w + x0, e = y1 * l.w + x1;
                c[y * nw + x] = (l.cover[a] + l.cover[b] + l.cover[d] + l.cover[e] + 2) >> 2;
                t[y * nw + x] = (l.lit[a] + l.lit[b] + l.lit[d] + l.lit[e] + 2) >> 2;
            }
        }
        levels.push({w: nw, h: nh, cover: c, lit: t});
    }

    const total = hist.reduce((a, b) => a + b, 0);
    const percentile = (p: number) => {
        let seen = 0;
        for (let v = 0; v < 256; v++) if ((seen += hist[v]) > p * total) return v;
        return 255;
    };
    return {levels, lo: total ? percentile(0.01) : 0, hi: total ? percentile(0.99) : 255};
}

// which level has pixels about the size of a character that's this many degrees wide
export function levelFor(p: Pyramid, degreesPerCell: number): number {
    const level0 = 360 / p.levels[0].w;
    const l = Math.round(Math.log2(Math.max(degreesPerCell, 1e-9) / level0));
    return Math.max(0, Math.min(p.levels.length - 1, l));
}

// the ramp index for a spot, or 0 (blank) for water and the darkest land. smooth
// blends the four nearest pixels - for when characters are smaller than pixels,
// so coasts come out as curves instead of staircases
export function charAt(p: Pyramid, level: number, lon: number, lat: number, rampLength: number, gamma = 1, smooth = false): number {
    const l = p.levels[level];
    const fx = (((((lon + 180) / 360) % 1) + 1) % 1) * l.w;
    const fy = ((90 - lat) / 180) * l.h;
    if (fy < 0 || fy >= l.h) return 0;
    let cover: number, lit: number;
    if (smooth) {
        // pixel centres sit at +0.5, so blend from the one up and to the left
        const x0 = Math.floor(fx - 0.5), y0 = Math.floor(fy - 0.5);
        const tx = fx - 0.5 - x0, ty = fy - 0.5 - y0;
        const xa = (x0 + l.w) % l.w, xb = (x0 + 1) % l.w; // east-west wraps
        const ya = Math.max(0, y0), yb = Math.min(l.h - 1, y0 + 1); // north-south doesn't
        const mix = (g: Uint8Array) =>
            (g[ya * l.w + xa] * (1 - tx) + g[ya * l.w + xb] * tx) * (1 - ty) + (g[yb * l.w + xa] * (1 - tx) + g[yb * l.w + xb] * tx) * ty;
        cover = mix(l.cover);
        lit = mix(l.lit);
    } else {
        const i = Math.floor(fy) * l.w + Math.min(Math.floor(fx), l.w - 1);
        cover = l.cover[i];
        lit = l.lit[i];
    }
    if (cover < LAND) return 0;
    const brightness = (lit * 255) / cover;
    const v = Math.min(1, Math.max(0, (brightness - p.lo) / Math.max(1, p.hi - p.lo))) ** gamma;
    return Math.min(rampLength - 1, Math.floor(v * rampLength));
}

// which way a border runs through a cell, in grid units (rows count downwards).
// characters are twice as tall as wide, so a 45° line in the grid is steep on screen
// - and that's what / and \ look like too
export function borderChar(dc: number, dr: number): number {
    const a = Math.abs((Math.atan2(dr, dc) * 180) / Math.PI);
    if (a < 22.5 || a > 157.5) return 0; // -
    if (a > 67.5 && a < 112.5) return 1; // |
    return dr > 0 === dc > 0 ? 3 : 2; // \ going down-right, / going up-right
}

export const cellKey = (c: number, r: number) => r * 4194304 + (c + 2097152);

// marks every cell a segment (in grid units) passes through with its border
// character, within the given columns and rows
export function traceSegment(cells: Map<number, number>, c0: number, r0: number, c1: number, r1: number, cols: [number, number], rows: [number, number]) {
    if ((c0 < cols[0] && c1 < cols[0]) || (c0 > cols[1] && c1 > cols[1]) || (r0 < rows[0] && r1 < rows[0]) || (r0 > rows[1] && r1 > rows[1])) return;
    const dc = c1 - c0, dr = r1 - r0;
    const ch = borderChar(dc, dr);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dc), Math.abs(dr)) * 2));
    for (let i = 0; i <= steps; i++) {
        const c = Math.floor(c0 + (dc * i) / steps), r = Math.floor(r0 + (dr * i) / steps);
        if (c >= cols[0] && c <= cols[1] && r >= rows[0] && r <= rows[1]) cells.set(cellKey(c, r), ch);
    }
}

// web mercator: where a latitude sits, 0 at the top of the map (85.05°N) to 1 at the bottom
export function mercatorY(lat: number): number {
    const φ = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
    return 0.5 - Math.log(Math.tan(Math.PI / 4 + φ / 2)) / (2 * Math.PI);
}

// what the map's showing, in screen pixels - enough to lay out the grid without
// knowing anything about deck.gl
export type View = {
    width: number;
    height: number;
    x0: number; // where longitude -180 is
    worldWidth: number; // how wide 360 degrees are
    y0: number; // where the top of the map (85.05°N) is
    worldHeight: number; // how tall the whole map is
    latAt: (y: number) => number;
};

export class AsciiLayer {
    #canvas: HTMLCanvasElement;
    #ctx: CanvasRenderingContext2D;
    #lineCanvas: HTMLCanvasElement; // the connections, over the land - redrawn on their own
    #lineCtx: CanvasRenderingContext2D;
    #pyramid?: Pyramid;
    #atlas?: HTMLCanvasElement;
    #atlasKey = ''; // what the atlas was drawn for - pixel ratio + colours
    #cellW = 0;
    #cellH = 0;
    #view?: View;
    #borders: Float64Array[] = []; // lon, lat, lon, lat...
    #paths: AsciiPath[] = [];
    #pathsKey = '';
    #lineAtlases = new Map<string, HTMLCanvasElement>(); // by colour + size

    constructor(canvas: HTMLCanvasElement, lineCanvas: HTMLCanvasElement) {
        this.#canvas = canvas;
        this.#ctx = canvas.getContext('2d')!;
        this.#lineCanvas = lineCanvas;
        this.#lineCtx = lineCanvas.getContext('2d')!;
    }

    async load(url: string) {
        const blob = await (await fetch(url)).blob();
        // the values are data, not colours - nothing gets to adjust them
        const bitmap = await createImageBitmap(blob, {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
        const c = document.createElement('canvas');
        c.width = bitmap.width;
        c.height = bitmap.height;
        const ctx = c.getContext('2d', {willReadFrequently: true})!;
        ctx.drawImage(bitmap, 0, 0);
        this.#pyramid = buildPyramid(bitmap.width, bitmap.height, ctx.getImageData(0, 0, bitmap.width, bitmap.height).data);
        bitmap.close();
        if (this.#view) this.draw(this.#view);
    }

    // borders.json - see web/scripts/build-overlays.mjs
    async loadBorders(url: string) {
        const b = await (await fetch(url)).json();
        this.#borders = (b.lines as [number, number][][]).map(line => Float64Array.from(line.flat()));
        if (this.#view) this.draw(this.#view);
    }

    // the connections, drawn in characters on the grid - later ones on top. only
    // they're redrawn, and only if something about them changed
    setPaths(paths: AsciiPath[]) {
        const key = paths.map(p => `${p.color}|${p.alpha.toFixed(2)}|${p.end}|${p.quiet}|${p.path.length}|${p.path[0]}|${p.path[p.path.length - 1]}`).join(';');
        this.#paths = paths;
        if (key === this.#pathsKey) return;
        this.#pathsKey = key;
        if (this.#view) this.#drawLines(this.#view);
    }

    // a connection's characters in its colour, pre-drawn like the map's - in a
    // lighter weight for a quiet one
    #lineGlyphs(color: string, dpr: number, gw: number, gh: number, quiet = false) {
        const key = `${color}|${dpr}|${gw}x${gh}|${quiet}`;
        let atlas = this.#lineAtlases.get(key);
        if (atlas) return atlas;
        atlas = document.createElement('canvas');
        atlas.width = gw * LINE_CHARS.length;
        atlas.height = gh;
        const a = atlas.getContext('2d')!;
        a.textAlign = 'center';
        a.textBaseline = 'middle';
        a.font = `${quiet ? '' : 'bold '}${ASCII.fontPx * ASCII.lineScale * dpr}px ${ASCII.font}`;
        a.fillStyle = a.strokeStyle = color;
        a.lineWidth = 0.35 * dpr; // a touch heavier than bold
        [...LINE_CHARS].forEach((ch, i) => {
            a.fillText(ch, i * gw + gw / 2, gh / 2);
            if (!quiet) a.strokeText(ch, i * gw + gw / 2, gh / 2);
        });
        this.#lineAtlases.set(key, atlas);
        return atlas;
    }

    // every character, pre-drawn once in the tint - drawing from this is much
    // faster than fillText for each of the ~15k on screen
    #glyphs(dpr: number) {
        // colours come from colors.css (--ascii-land, --ascii-border), and get re-read
        // each draw - so editing them redraws the glyphs too
        const land = themeVar('--ascii-land'), border = themeVar('--ascii-border');
        const key = `${dpr}|${land}|${border}`;
        if (this.#atlas && this.#atlasKey === key) return this.#atlas;
        const font = `${ASCII.fontPx}px ${ASCII.font}`;
        this.#ctx.font = font;
        this.#cellW = this.#ctx.measureText('M').width;
        this.#cellH = ASCII.fontPx * ASCII.lineHeight;
        const gw = Math.ceil(this.#cellW * dpr), gh = Math.ceil(this.#cellH * dpr);
        const atlas = document.createElement('canvas');
        atlas.width = gw * (ASCII.ramp.length + BORDER_CHARS.length);
        atlas.height = gh;
        const a = atlas.getContext('2d')!;
        a.textAlign = 'center';
        a.textBaseline = 'middle';
        a.font = `${ASCII.fontPx * dpr}px ${ASCII.font}`;
        a.fillStyle = land;
        [...ASCII.ramp].forEach((ch, i) => a.fillText(ch, i * gw + gw / 2, gh / 2));
        // borders in bold + their own colour, so they don't sink into the land's own - and |
        a.font = `bold ${ASCII.fontPx * dpr}px ${ASCII.font}`;
        a.fillStyle = border;
        [...BORDER_CHARS].forEach((ch, i) => a.fillText(ch, (ASCII.ramp.length + i) * gw + gw / 2, gh / 2));
        this.#atlas = atlas;
        this.#atlasKey = key;
        return atlas;
    }

    // the grid's pinned to the world, not the screen, so characters ride along with
    // the map when it's dragged instead of shimmering through it. these are the
    // columns + rows on screen
    #grid(v: View) {
        const W = this.#cellW, H = this.#cellH;
        const colFrom = Math.floor(-v.x0 / W) - 1, colTo = Math.ceil((v.width - v.x0) / W);
        const rowFrom = Math.max(0, Math.floor(-v.y0 / H)), rowTo = Math.min(Math.ceil(v.worldHeight / H), Math.ceil((v.height - v.y0) / H));
        const lastRow = Math.min(rowTo - 1, Math.floor((mercatorY(ASCII.minLat) * v.worldHeight) / H));
        // the map repeats sideways, so lines are traced once per copy of the world on screen
        const colsPerWorld = v.worldWidth / W;
        const copies: number[] = [];
        for (let copy = Math.floor(colFrom / colsPerWorld) - 1; copy * colsPerWorld <= colTo; copy++) copies.push(copy);
        return {W, H, colFrom, colTo, rowFrom, rowTo, lastRow, colsPerWorld, copies};
    }

    #fit(canvas: HTMLCanvasElement, v: View, dpr: number) {
        const w = Math.round(v.width * dpr), h = Math.round(v.height * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        canvas.getContext('2d')!.clearRect(0, 0, w, h);
    }

    draw(v: View) {
        this.#view = v;
        this.#drawLand(v);
        this.#drawLines(v);
    }

    #drawLand(v: View) {
        const dpr = window.devicePixelRatio || 1;
        this.#fit(this.#canvas, v, dpr);
        const ctx = this.#ctx;
        const p = this.#pyramid;
        if (!p) return;

        const atlas = this.#glyphs(dpr);
        const gw = Math.ceil(this.#cellW * dpr), gh = Math.ceil(this.#cellH * dpr);
        const {W, H, colFrom, colTo, rowFrom, rowTo, lastRow, colsPerWorld, copies} = this.#grid(v);
        const across = (360 * W) / v.worldWidth; // degrees a character spans, west to east
        const n = ASCII.ramp.length;
        const lons: number[] = [];
        for (let c = colFrom; c <= colTo; c++) lons.push(((c + 0.5) * W * 360) / v.worldWidth - 180);

        // borders first, so the land knows which cells they've taken
        const borders = new Map<number, number>();
        for (const copy of copies) {
            for (const line of this.#borders) {
                let pc = 0, pr = 0;
                for (let i = 0; i < line.length; i += 2) {
                    const c = ((line[i] + 180) / 360 + copy) * colsPerWorld;
                    const r = (mercatorY(line[i + 1]) * v.worldHeight) / H;
                    if (i > 0) traceSegment(borders, pc, pr, c, r, [colFrom, colTo], [rowFrom, lastRow]);
                    pc = c;
                    pr = r;
                }
            }
        }

        ctx.globalAlpha = ASCII.opacity;
        for (let r = rowFrom; r < rowTo; r++) {
            const y = v.y0 + r * H;
            const lat = v.latAt(y + H / 2);
            if (lat < ASCII.minLat) break;
            // towards the poles the projection stretches a character over less
            // latitude than longitude - the finer of the two picks the detail, so
            // stretched rows show new ground instead of repeating the one above
            const down = Math.abs(v.latAt(y) - v.latAt(y + H));
            const level = levelFor(p, Math.min(across, down));
            // zoomed in past a pixel a character - blend, rather than repeat pixels in blocks
            const smooth = level === 0 && Math.min(across, down) < 360 / p.levels[0].w;
            const dy = Math.round(y * dpr);
            for (let k = 0; k < lons.length; k++) {
                if (borders.has(cellKey(colFrom + k, r))) continue;
                const ch = charAt(p, level, lons[k], lat, n, ASCII.gamma, smooth);
                if (ch === 0) continue;
                const dx = Math.round((v.x0 + (colFrom + k) * W) * dpr);
                ctx.drawImage(atlas, ch * gw, 0, gw, gh, dx, dy, gw, gh);
            }
        }

        ctx.globalAlpha = ASCII.borderOpacity;
        for (const [key, ch] of borders) {
            const r = Math.floor(key / 4194304), c = key - r * 4194304 - 2097152;
            const dx = Math.round((v.x0 + c * W) * dpr), dy = Math.round((v.y0 + r * H) * dpr);
            ctx.drawImage(atlas, (n + ch) * gw, 0, gw, gh, dx, dy, gw, gh);
        }
        ctx.globalAlpha = 1;
    }

    // the connections, on their own canvas over the land: each character blanks out
    // the patch of map under it (in the sea's colour), then draws in its own
    #drawLines(v: View) {
        const dpr = window.devicePixelRatio || 1;
        this.#fit(this.#lineCanvas, v, dpr);
        if (!this.#pyramid || !this.#paths.length) return;
        this.#glyphs(dpr); // measures the cells
        const ctx = this.#lineCtx;
        const {W, H, colFrom, colTo, rowFrom, lastRow, copies} = this.#grid(v);
        const S = ASCII.lineScale; // a connection's character covers S x S of the map's
        const lineCols: [number, number] = [Math.floor(colFrom / S), Math.ceil(colTo / S)];
        const lineRows: [number, number] = [Math.floor(rowFrom / S), Math.floor(lastRow / S)];

        // every line on screen, in px - each leg on its own track where it shares one
        const offsets = tracks(this.#paths);
        const onScreen: {p: AsciiPath; pts: [number, number][]}[] = [];
        for (const copy of copies) {
            const project = ([lon, lat]: [number, number]): [number, number] => [
                v.x0 + ((lon + 180) / 360 + copy) * v.worldWidth,
                v.y0 + mercatorY(lat) * v.worldHeight,
            ];
            this.#paths.forEach((p, i) => {
                const legs = p.legs ?? [p.path];
                const pts: [number, number][] = [];
                legs.forEach((leg, j) => {
                    const shifted = offsetLine(leg.map(project), offsets[i]?.[j] ?? 0);
                    pts.push(...(j ? shifted.slice(1) : shifted));
                });
                // nowhere near the screen - skip it
                if (pts.every(([x]) => x < -v.width) || pts.every(([x]) => x > 2 * v.width)) return;
                onScreen.push({p, pts});
            });
        }

        // traced through the grid, the busiest last so they win the cells they share
        const lines = new Map<number, {ch: number; path: AsciiPath}>(); // in S-sized cells
        const cell = ([x, y]: [number, number]): [number, number] => [(x - v.x0) / (W * S), (y - v.y0) / (H * S)];
        for (const {p, pts} of onScreen) {
            const cells = new Map<number, number>();
            for (let i = 1; i < pts.length; i++) {
                const [c0, r0] = cell(pts[i - 1]), [c1, r1] = cell(pts[i]);
                traceSegment(cells, c0, r0, c1, r1, lineCols, lineRows);
            }
            if (p.end && pts.length) {
                const [c, r] = cell(pts[pts.length - 1]).map(Math.floor);
                if (c >= lineCols[0] && c <= lineCols[1] && r >= lineRows[0] && r <= lineRows[1]) cells.set(cellKey(c, r), LINE_END);
            }
            for (const [key, ch] of cells) lines.set(key, {ch, path: p});
        }

        const lw = Math.ceil(W * S * dpr), lh = Math.ceil(H * S * dpr);
        const at = (key: number) => {
            const r = Math.floor(key / 4194304), c = key - r * 4194304 - 2097152;
            return [Math.round((v.x0 + c * S * W) * dpr), Math.round((v.y0 + r * S * H) * dpr)];
        };
        // the map under them blanked out first
        ctx.fillStyle = themeVar('--map-bg');
        for (const key of lines.keys()) {
            const [dx, dy] = at(key);
            ctx.fillRect(dx, dy, lw, lh);
        }
        // then the fine line through them, and the chevrons along it
        ctx.lineJoin = ctx.lineCap = 'round';
        for (const {p, pts} of onScreen) {
            ctx.strokeStyle = p.color;
            if (ASCII.lineUnderlay > 0) {
                ctx.globalAlpha = p.alpha * ASCII.lineUnderlay;
                ctx.lineWidth = (p.quiet ? ASCII.quietLineWidth : ASCII.lineWidth) * dpr;
                ctx.beginPath();
                pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * dpr, y * dpr) : ctx.moveTo(x * dpr, y * dpr)));
                ctx.stroke();
            }
            if (p.end && !p.quiet) {
                ctx.globalAlpha = p.alpha;
                ctx.lineWidth = TRACKS.arrowWidth * dpr;
                ctx.beginPath();
                const {arrowLength: back, arrowSpread: out} = TRACKS;
                for (const [x, y, dx, dy] of arrowsAlong(pts, TRACKS.arrowsEvery, stagger(p.key ?? ''))) {
                    // a > pointing the way the line goes, as one stroke so its tip's clean
                    ctx.moveTo((x - back * dx - out * dy) * dpr, (y - back * dy + out * dx) * dpr);
                    ctx.lineTo(x * dpr, y * dpr);
                    ctx.lineTo((x - back * dx + out * dy) * dpr, (y - back * dy - out * dx) * dpr);
                }
                ctx.stroke();
            }
        }
        // and the characters over it
        for (const [key, {ch, path}] of lines) {
            const [dx, dy] = at(key);
            ctx.globalAlpha = path.alpha;
            ctx.drawImage(this.#lineGlyphs(path.color, dpr, lw, lh, path.quiet), ch * lw, 0, lw, lh, dx, dy, lw, lh);
        }
        ctx.globalAlpha = 1;
    }
}

// lines all start at home, so their arrows would line up in columns - each line's
// start somewhere between a quarter and three quarters of the way to the next, by key
function stagger(key: string): number {
    let h = 0;
    for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return 0.25 + 0.5 * ((h % 1000) / 1000);
}

// points every so many px along a line (the first `first` of that in), with which way
// it's heading there as a unit vector - x, y, dx, dy
export function arrowsAlong(pts: [number, number][], every: number, first = 0.5): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    let next = every * first, walked = 0;
    for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const len = Math.hypot(bx - ax, by - ay);
        while (len > 0 && walked + len >= next) {
            const f = (next - walked) / len;
            out.push([ax + (bx - ax) * f, ay + (by - ay) * f, (bx - ax) / len, (by - ay) / len]);
            next += every;
        }
        walked += len;
    }
    return out;
}
