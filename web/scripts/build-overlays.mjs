// what the ascii basemap draws on top of the land (see src/ascii.ts):
// public/data/borders.json, the lines between countries - Natural Earth's 1:50m
// boundaries (public domain), from world-atlas
//
//   npm run overlays
import {readFile, writeFile} from 'node:fs/promises';
import {mesh} from 'topojson-client';

const round = n => Math.round(n * 100) / 100; // ~1km - finer than the ascii ever gets

// only arcs shared by two different countries - coasts are already the edge of the land
const topo = JSON.parse(await readFile(new URL('../node_modules/world-atlas/countries-50m.json', import.meta.url), 'utf8'));
const borders = mesh(topo, topo.objects.countries, (a, b) => a !== b).coordinates.map(line => line.map(([lon, lat]) => [round(lon), round(lat)]));
await writeFile(new URL('../public/data/borders.json', import.meta.url), JSON.stringify({source: 'Natural Earth 1:50m admin-0 boundaries, via world-atlas', lines: borders}));
console.log(`${borders.length} border lines, ${borders.reduce((n, l) => n + l.length, 0)} points`);
