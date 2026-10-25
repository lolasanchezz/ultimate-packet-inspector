// fetches TeleGeography's submarine cable map (CC BY-SA 4.0,
// https://www.submarinecablemap.com) and squeezes it into public/data/cables.json:
// each cable's name, colour and lines, with coordinates rounded to ~1km
//
//   npm run cables
import { writeFile } from 'node:fs/promises';

const src = 'https://www.submarinecablemap.com/api/v3/cable/cable-geo.json';

const res = await fetch(src);
if (!res.ok) throw new Error(`${src}: ${res.status}`);
const geo = await res.json();

const round = n => Math.round(n * 100) / 100;
const byId = new Map();
for (const f of geo.features) {
    const {id, name, color} = f.properties;
    const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    const cable = byId.get(id) ?? {name, color, lines: []};
    for (const line of lines) cable.lines.push(line.map(([lon, lat]) => [round(lon), round(lat)]));
    byId.set(id, cable);
}

const out = {
    source: 'TeleGeography Submarine Cable Map, CC BY-SA 4.0 - https://www.submarinecablemap.com',
    cables: [...byId.values()],
};
await writeFile(new URL('../public/data/cables.json', import.meta.url), JSON.stringify(out));
console.log(`${out.cables.length} cables`);
