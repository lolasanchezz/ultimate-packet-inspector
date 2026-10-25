/// <reference types="vite/client" />

// set from UPI_SERVER + UPI_DB in the repo's .env - see vite.config.ts
interface ImportMetaEnv {
    readonly UPI_SERVER: string; // as a websocket url
    readonly UPI_DB: string; // the name the module's published under, '' if it wasn't set
}
