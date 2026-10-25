package upload

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func fixtureRecords() []Record {
	return []Record{
		{TimeUs: 1_700_000_000_000_500, Size: 66, Out: false, Flags: 0x10, TTL: 57},
		{TimeUs: 1_700_000_000_000_000, Size: 74, Out: true, Flags: 0x02, TTL: 64}, // out of order - a late match
		{TimeUs: 1_700_000_001_250_000, Size: 70000, Out: true, Flags: 0x18, TTL: 64},
	}
}

func TestChunkRoundTrip(t *testing.T) {
	c := Encode(42, 3, fixtureRecords())
	if c.N != 3 || c.T0Us != 1_700_000_000_000_000 || c.Weight != 3 || c.Conn != 42 {
		t.Fatalf("chunk header: %+v", c)
	}
	recs, err := Decode(c)
	if err != nil {
		t.Fatal(err)
	}
	want := []Record{
		{TimeUs: 1_700_000_000_000_000, Size: 74, Out: true, Flags: 0x02, TTL: 64},
		{TimeUs: 1_700_000_000_000_500, Size: 66, Out: false, Flags: 0x10, TTL: 57},
		{TimeUs: 1_700_000_001_250_000, Size: 65535, Out: true, Flags: 0x18, TTL: 64}, // capped
	}
	if !reflect.DeepEqual(recs, want) {
		t.Errorf("decoded:\n%+v\nwant\n%+v", recs, want)
	}
}

// the website decodes the same fixture (web/src/chunks.test.ts) - both sides
// have to agree on the format. run with UPDATE_FIXTURE=1 to rewrite it
func TestChunkFixture(t *testing.T) {
	path := filepath.Join("..", "..", "testdata", "chunk.json")
	c := Encode(42, 3, fixtureRecords())
	recs, _ := Decode(c)
	fixture := struct {
		Chunk   Chunk    `json:"chunk"`
		Records []Record `json:"records"`
	}{c, recs}
	data, _ := json.MarshalIndent(fixture, "", "  ")
	if os.Getenv("UPDATE_FIXTURE") != "" {
		os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v - run with UPDATE_FIXTURE=1 to make it", err)
	}
	if string(saved) != string(data)+"\n" {
		t.Error("testdata/chunk.json is out of date with the encoder - run with UPDATE_FIXTURE=1")
	}
}
