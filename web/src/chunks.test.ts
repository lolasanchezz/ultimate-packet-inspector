import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {decodeChunk, flagNames} from './chunks';

// written by the agent's TestChunkFixture - both sides have to agree on the format
const fixture = JSON.parse(readFileSync(new URL('../../testdata/chunk.json', import.meta.url), 'utf8'));

describe('chunks', () => {
    it('decodes what the go agent encodes', () => {
        expect(decodeChunk(fixture.chunk.t0, fixture.chunk.data)).toEqual(fixture.records);
    });

    it('names tcp flags', () => {
        expect(flagNames(0x12)).toEqual(['SYN', 'ACK']);
    });
});
