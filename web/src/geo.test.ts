import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {feature} from 'topojson-client';
import landTopo from 'world-atlas/land-110m.json';
import type {Topology} from 'topojson-specification';
import {Land, cableBetween, circle, distanceKm, greatCircle, maxKm, unwrap, type Cable, type LonLat} from './geo';
import {landRings} from './paths';

const sf: LonLat = [-122.42, 37.77];
const nyc: LonLat = [-74.01, 40.71];
const london: LonLat = [-0.13, 51.51];
const sydney: LonLat = [151.21, -33.87];
const tokyo: LonLat = [139.69, 35.68];

const topo = landTopo as unknown as Topology;
const land = new Land(landRings(feature(topo, topo.objects.land)));
const cables: Cable[] = JSON.parse(readFileSync(new URL('../public/data/cables.json', import.meta.url), 'utf8')).cables;

describe('geo', () => {
    it('measures great circles', () => {
        expect(distanceKm(nyc, london)).toBeGreaterThan(5550);
        expect(distanceKm(nyc, london)).toBeLessThan(5600);
        const gc = greatCircle(nyc, london);
        expect(gc[0]).toEqual(nyc);
        expect(distanceKm(gc[gc.length - 1], london)).toBeLessThan(0.01);
    });

    it('keeps pacific crossings continuous', () => {
        const path = unwrap(greatCircle(sf, tokyo));
        for (let i = 1; i < path.length; i++) expect(Math.abs(path[i][0] - path[i - 1][0])).toBeLessThan(10);
    });

    it('draws rings the right size', () => {
        for (const p of circle(sf, maxKm(10))) expect(distanceKm(sf, [((p[0] + 540) % 360) - 180, p[1]])).toBeCloseTo(1000, -1);
    });

    it('knows land from sea', () => {
        expect(land.contains([-100, 40])).toBe(true); // kansas
        expect(land.contains([-150, 30])).toBe(false); // mid pacific
        expect(land.crossesWater(sf, tokyo)).toBe(true);
        expect(land.crossesWater(sf, nyc)).toBe(false);
    });

    it('finds a cable across the pacific', () => {
        const found = cableBetween(cables, sf, sydney);
        expect(found).not.toBeNull();
        expect(distanceKm(found!.path[0], sf)).toBeLessThan(900);
        expect(distanceKm(found!.path[found!.path.length - 1], sydney)).toBeLessThan(900);
        // and it doesn't wander - the cable's no more than half again as long as the straight line
        let km = 0;
        for (let i = 1; i < found!.path.length; i++) km += distanceKm(found!.path[i - 1], found!.path[i]);
        expect(km).toBeLessThan(1.5 * distanceKm(sf, sydney));
    });
});
