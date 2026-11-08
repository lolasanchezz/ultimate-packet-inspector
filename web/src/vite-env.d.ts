/// <reference types="vite/client" />

// set from UPI_AGENT at build time, if it's set - see vite.config.ts
interface ImportMetaEnv {
    readonly UPI_AGENT: string; // where the agent broadcasts, e.g. http://127.0.0.1:7323
}
