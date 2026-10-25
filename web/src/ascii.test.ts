import {describe, expect, it} from 'vitest';
import {TRACKS, arrowsAlong, borderChar, buildPyramid, cellKey, charAt, levelFor, mercatorY, offsetLine, traceSegment, tracks, type AsciiPath} from './ascii';

// an 8x4 world: the west half sea, the east half land getting brighter eastwards
function world() {
    const w = 8, h = 4, rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const land = x >= 4;
            rgba[i] = land ? 60 + (x - 4) * 60 : 0; // brightness, times the land share
            rgba[i + 1] = land ? 255 : 0; // land share
        }
    return buildPyramid(w, h, rgba);
}

describe('ascii', () => {
    it('averages down without coasts turning into dark land', () => {
        const p = world();
        expect(p.levels.map(l => `${l.w}x${l.h}`)).toEqual(['8x4', '4x2', '2x1']);
        // the last level's west pixel is all sea, the east all land
        expect(p.levels[2].cover[0]).toBe(0);
        expect(p.levels[2].cover[1]).toBe(255);
    });

    it('spreads land brightness over the ramp, and leaves water blank', () => {
        const p = world();
        expect(p.lo).toBe(60);
        expect(p.hi).toBe(240);
        expect(charAt(p, 0, -170, 0, 10)).toBe(0); // the sea
        expect(charAt(p, 0, 10, 0, 10)).toBe(0); // the darkest land
        expect(charAt(p, 0, 170, 0, 10)).toBe(9); // the brightest
        expect(charAt(p, 0, 170 + 360, 0, 10)).toBe(9); // a world over, the same
        expect(charAt(p, 0, 170, 95, 10)).toBe(0); // off the top
    });

    it('picks the level whose pixels match a character', () => {
        const p = world(); // 45° pixels at full size
        expect(levelFor(p, 45)).toBe(0);
        expect(levelFor(p, 90)).toBe(1);
        expect(levelFor(p, 1000)).toBe(2);
        expect(levelFor(p, 1)).toBe(0);
    });

    it('blends between pixels when characters are smaller than them', () => {
        const p = world(); // the coast is at 0° longitude, between pixel 3 (sea) and 4 (land)
        // right on the coast, half sea and half land - just under the line, so blank
        expect(charAt(p, 0, -0.1, 0, 10, 1, true)).toBe(0);
        // inland, between two land pixels, it's somewhere between their brightnesses
        expect(charAt(p, 0, 60, 0, 10, 1, true)).toBeGreaterThan(charAt(p, 0, 30, 0, 10, 1, false));
        expect(charAt(p, 0, 60, 0, 10, 1, true)).toBeLessThan(charAt(p, 0, 120, 0, 10, 1, false));
        // the far east blends with the far west across the date line, where this
        // world's other coast is - land just east of it, sea just west
        expect(charAt(p, 0, 179.9, 0, 10, 1, true)).toBe(9);
        expect(charAt(p, 0, -179.9, 0, 10, 1, true)).toBe(0);
    });

    it('picks border characters by direction', () => {
        const [dash, bar, slash, back] = [0, 1, 2, 3];
        expect(borderChar(5, 0)).toBe(dash);
        expect(borderChar(-5, 1)).toBe(dash);
        expect(borderChar(0, 3)).toBe(bar);
        expect(borderChar(1, -1)).toBe(slash); // up and to the right - rows count downwards
        expect(borderChar(1, 1)).toBe(back);
        expect(borderChar(-1, -1)).toBe(back);
    });

    it('traces a border through every cell it crosses, and nowhere else', () => {
        const cells = new Map<number, number>();
        traceSegment(cells, 0.5, 2.5, 6.5, 2.5, [0, 100], [0, 100]); // straight across row 2
        expect([...cells.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6].map(c => cellKey(c, 2)));
        expect(new Set(cells.values())).toEqual(new Set([0]));
        // clipped to what's on screen
        const clipped = new Map<number, number>();
        traceSegment(clipped, -50, 1.5, 50, 1.5, [0, 3], [0, 10]);
        expect(clipped.size).toBe(4);
        // entirely off screen - nothing
        const off = new Map<number, number>();
        traceSegment(off, -10, 1, -5, 1, [0, 3], [0, 10]);
        expect(off.size).toBe(0);
    });

    it('places latitudes like web mercator', () => {
        expect(mercatorY(0)).toBeCloseTo(0.5);
        expect(mercatorY(85.0511)).toBeCloseTo(0, 4);
        expect(mercatorY(-85.0511)).toBeCloseTo(1, 4);
        expect(mercatorY(60)).toBeLessThan(mercatorY(30) - (mercatorY(30) - mercatorY(0))); // stretched towards the poles
    });

    it('puts lines that share a stretch on their own tracks', () => {
        const sf: [number, number] = [-122.4, 37.8], paloAlto: [number, number] = [-122.1, 37.4], ashburn: [number, number] = [-77.5, 39.0], montreal: [number, number] = [-73.6, 45.5];
        const line = (key: string, ...stops: [number, number][]): AsciiPath => ({
            key, color: 'red', alpha: 1, path: stops, legs: stops.slice(1).map((s, i) => [stops[i], s]),
        });
        const [a, b, loop] = tracks([
            line('a', sf, paloAlto, ashburn),
            line('b', sf, paloAlto, montreal),
            line('loop', ashburn, montreal, ashburn), // there and back
        ]);
        // sf to palo alto is shared: a and b either side of it. after that, their own ways
        expect(a[0]).toBe(-TRACKS.gap / 2);
        expect(b[0]).toBe(TRACKS.gap / 2);
        expect([a[1], b[1]]).toEqual([0, 0]);
        // ashburn-montreal both ways: the same number each way round, which with the way
        // flipped puts them on opposite sides - a loop instead of a dead end
        expect(loop[0]).toBe(loop[1]);
        expect(Math.abs(loop[0])).toBe(TRACKS.gap / 2);
    });

    it('shifts a line to the right of its way, easing in and out', () => {
        const flat: [number, number][] = [[0, 0], [50, 0], [100, 0]];
        const moved = offsetLine(flat, 3, 20);
        expect(moved[0]).toEqual([0, 0]); // meets the others at the ends
        expect(moved[2]).toEqual([100, 0]);
        expect(moved[1]).toEqual([50, 3]); // heading right on screen, right is down
        expect(offsetLine(flat, 0)).toBe(flat);
    });

    it('spaces arrows along a line, pointing the way it goes', () => {
        const arrows = arrowsAlong([[0, 0], [100, 0], [100, 100]], 60);
        expect(arrows.map(([x, y]) => [x, y])).toEqual([[30, 0], [90, 0], [100, 50]]);
        expect(arrows[2].slice(2)).toEqual([0, 1]); // heading down the second stretch
    });
});
