import {defineConfig, loadEnv} from 'vite';

// where the database is comes from the repo's .env (shared with the agent and the
// module's deploy script), or the environment when there's no file - a host's
// build settings, say. only these two make it into the bundle
export default defineConfig(({mode}) => {
    const env = loadEnv(mode, '..', 'UPI_');
    // the agent wants https://, a websocket wants wss:// - take either
    const server = (env.UPI_SERVER || 'https://maincloud.spacetimedb.com').replace(/^http/, 'ws').replace(/\/$/, '');
    return {
        build: {target: 'es2022', chunkSizeWarningLimit: 2000},
        define: {
            'import.meta.env.UPI_SERVER': JSON.stringify(server),
            'import.meta.env.UPI_DB': JSON.stringify(env.UPI_DB ?? ''),
        },
    };
});
