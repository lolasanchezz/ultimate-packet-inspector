import {describe, expect, it} from 'vitest';
import type {LonLat} from './geo';
import {chooseStops, routeLimitKm, type Hop} from './paths';

const sf: LonLat = [-122.413, 37.755];
const ashburn: LonLat = [-77.48, 39.02];

const stop = (city: string, at: LonLat, from = 'geoip') => ({
    at,
    hop: {ttl: 0, ip: '1.2.3.4', rttMs: 0, ptr: '', asn: 0, org: '', lat: at[1], lon: at[0], located: true, city, country: '', from, possible: true} as Hop,
});
const through = (stops: {hop: Hop}[]) => stops.map(s => s.hop.city);

describe('routes', () => {
    it('takes out a router that sends the line out and straight back', () => {
        // the real one: ashburn's routers listed in chicago and fremont by geo-ip
        const stops = [stop('Fremont', [-121.9, 37.5]), stop('Chicago', [-87.6, 41.9]), stop('Fremont', [-121.9, 37.5]), stop('Ashburn', [-77.5, 39.0])];
        expect(through(chooseStops(sf, stops, ashburn, routeLimitKm(sf, ashburn, 68)))).toEqual(['Fremont', 'Fremont', 'Ashburn']);
    });

    it('cuts the biggest detours until a route fits its round trip', () => {
        // the real one: 32,700km to virginia, in 73ms - santiago from "scl", naples from "phoenix-nap"
        const stops = [
            stop('Princeton', [-74.6, 40.3]),
            stop('Santiago', [-70.8, -33.4], 'scl'),
            stop('Paris', [2.4, 48.9]),
            stop('Napoli', [14.3, 40.9], 'nap'),
            stop('Ashburn', [-77.5, 39.0]),
        ];
        const limit = routeLimitKm(sf, ashburn, 73);
        expect(limit).toBeCloseTo(2 * 7300 - 3870, -2);
        expect(through(chooseStops(sf, stops, ashburn, limit))).toEqual(['Princeton', 'Ashburn']);
    });

    it('leaves a real roundabout route alone', () => {
        // san francisco to virginia by way of the southwest, in 80ms - long, but possible
        const stops = [stop('San Jose', [-121.89, 37.34], 'sjc'), stop('Los Angeles', [-118.24, 34.05], 'lax'), stop('Phoenix', [-112.07, 33.45], 'phx'), stop('Dallas', [-96.8, 32.78], 'dal')];
        expect(through(chooseStops(sf, stops, ashburn, routeLimitKm(sf, ashburn, 80)))).toEqual(['San Jose', 'Los Angeles', 'Phoenix', 'Dallas']);
        // with no round trip known, nothing's cut for length
        expect(routeLimitKm(sf, ashburn, 0)).toBe(Infinity);
    });
});
