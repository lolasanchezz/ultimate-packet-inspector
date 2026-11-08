import {defineConfig, loadEnv} from 'vite';

// where the agent broadcasts: its default (agent/broadcast's DefaultListen),
// unless UPI_AGENT says otherwise - for an agent run with -listen
export default defineConfig(({mode}) => {
    const env = loadEnv(mode, '..', 'UPI_');
    return {
        build: {target: 'es2022', chunkSizeWarningLimit: 2000},
        define: {
            'import.meta.env.UPI_AGENT': JSON.stringify((env.UPI_AGENT || 'http://127.0.0.1:7323').replace(/\/$/, '')),
        },
    };
});
