// number + time formatting

export function fmtBytes(n: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < units.length - 1) {
        n /= 1000;
        i++;
    }
    const digits = i === 0 || n >= 10 ? 0 : 1;
    return `${n.toFixed(digits)} ${units[i]}`;
}

export const fmtRate = (n: number) => `${fmtBytes(n)}/s`;
export const fmtCount = (n: number) => Math.round(n).toLocaleString('en');
export const fmtPerSecond = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString('en')}/s`;
export const fmtPct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;

// a length of time, as short as it'll go: 4.2s, 3m 10s, 2h 5m, 3d 4h
export function fmtDuration(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}
export const fmtMs = (ms: number) => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
// the time between things - milliseconds while it's short, then seconds and minutes
export const fmtGap = (ms: number) => (ms < 1000 ? fmtMs(ms) : fmtDuration(ms));
export const fmtKm = (km: number) => `${km < 100 ? km.toFixed(0) : Math.round(km / 10) * 10} km`;
// for distances added up, which get very big
export function fmtKmTotal(km: number): string {
    if (km < 10_000) return fmtKm(km);
    if (km < 1e6) return `${Math.round(km / 1000)}k km`;
    if (km < 1e9) return `${(km / 1e6).toFixed(1)}m km`;
    return `${(km / 1e9).toFixed(1)}b km`;
}
export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], {hour12: false});
export const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], {hour12: false, hour: '2-digit', minute: '2-digit'});

export function fmtAgo(ms: number): string {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}

// a flag from a two-letter country code
export function flag(cc: string): string {
    if (!/^[A-Za-z]{2}$/.test(cc)) return '';
    return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function esc(s: string): string {
    return s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!);
}

export const PROTOS: Record<number, string> = {1: 'icmp', 6: 'tcp', 17: 'udp', 58: 'icmpv6'};

// what's usually on a port - "https" says more than "tcp"
const SERVICES: Record<string, string> = {
    '6/443': 'https', '17/443': 'quic', '6/80': 'http', '6/8080': 'http', '17/53': 'dns', '6/53': 'dns', '6/853': 'dns-tls',
    '17/123': 'ntp', '6/5223': 'apns', '6/993': 'imaps', '6/587': 'smtp', '6/22': 'ssh', '17/3478': 'stun', '17/5353': 'mdns',
    '17/1900': 'ssdp',
};
export const service = (proto: number, port: number) => SERVICES[`${proto}/${port}`] ?? PROTOS[proto] ?? String(proto);
