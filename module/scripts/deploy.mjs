// publishes this module to the database in the repo's .env (UPI_SERVER, UPI_DB),
// so it can't end up somewhere other than where the agent + website point.
// anything after `npm run deploy --` goes to `spacetime publish` as-is
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const env = new URL('../../.env', import.meta.url);
if (existsSync(env)) process.loadEnvFile(fileURLToPath(env));

const db = process.env.UPI_DB;
if (!db) {
    console.error("no UPI_DB - set it in the repo's .env (see .env.example)");
    process.exit(1);
}
// the cli wants the http(s) url, not the websocket one
const server = (process.env.UPI_SERVER || 'https://maincloud.spacetimedb.com').replace(/^ws/, 'http');
const moduleDir = fileURLToPath(new URL('..', import.meta.url));

console.log(`publishing to ${db} on ${server}`);
const {status} = spawnSync('spacetime', ['publish', '-s', server, '-p', moduleDir, db, ...process.argv.slice(2)], {stdio: 'inherit'});
process.exit(status ?? 1);
