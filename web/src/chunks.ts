// packet chunks: one connection's packet headers over one batch, 8 bytes each.
// the format's defined (and encoded) in agent/upload/batch.go
//
//   0-3  µs after t0 (u32, little endian)
//   4-5  size on the wire (u16, little endian)
//   6    bit 7 set when sent from the machine, bits 0-6 the tcp flags
//   7    ttl / hop limit

export type PacketRecord = {
    timeUs: number;
    size: number;
    out: boolean;
    flags: number;
    ttl: number;
};

export const RECORD_SIZE = 8;

export const TCP_FLAGS = {FIN: 1, SYN: 2, RST: 4, PSH: 8, ACK: 16, URG: 32, ECE: 64} as const;

export function decodeChunk(t0Us: number, data: string): PacketRecord[] {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const out: PacketRecord[] = [];
    for (let i = 0; i + RECORD_SIZE <= bytes.length; i += RECORD_SIZE) {
        out.push({
            timeUs: t0Us + view.getUint32(i, true),
            size: view.getUint16(i + 4, true),
            out: (bytes[i + 6] & 0x80) !== 0,
            flags: bytes[i + 6] & 0x7f,
            ttl: bytes[i + 7],
        });
    }
    return out;
}

export function flagNames(flags: number): string[] {
    return Object.entries(TCP_FLAGS)
        .filter(([, bit]) => flags & bit)
        .map(([name]) => name);
}
