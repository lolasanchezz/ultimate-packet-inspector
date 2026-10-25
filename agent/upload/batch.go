// Package upload sends what the agent sees to the SpacetimeDB module (see
// module/src/index.ts) - one ingest call per batch interval
package upload

import (
	"cmp"
	"encoding/base64"
	"encoding/binary"
	"slices"
)

// Batch is everything that changed since the last one. it goes to the ingest
// reducer as a json string, so the field names here are the module's
type Batch struct {
	TimeUs    int64       `json:"t"`
	Stats     Stats       `json:"stats"`
	Home      *Home       `json:"home,omitempty"` // only when it changed
	Conns     []Conn      `json:"conns"`
	Endpoints []Endpoint  `json:"endpoints"`
	Routes    []Route     `json:"routes"`
	Chunks    []Chunk     `json:"chunks"`
	Procs     []ProcUsage `json:"procs"`
}

type Stats struct {
	Iface   string  `json:"iface"`
	PPS     float64 `json:"pps"`     // packets per second over the batch
	Dropped int     `json:"dropped"` // by the kernel, since the agent started
	Nstat   bool    `json:"nstat"`   // flow events are working (vs socket scans)
	Geo     bool    `json:"geo"`     // the geo databases are loaded
	Sampled uint32  `json:"sampled"` // 1 in this many packets recorded, 1 = all of them
}

type Home struct {
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	Place string  `json:"place"`
}

// one process talking to one remote address + port. fixed header fields live here
// so chunks only carry what changes packet to packet
type Conn struct {
	ID          uint64  `json:"id"`
	Pid         int32   `json:"pid"`
	Process     string  `json:"process"`
	Proto       uint8   `json:"proto"`
	RemoteIP    string  `json:"remoteIp"`
	RemotePort  uint16  `json:"remotePort"`
	LocalPort   uint16  `json:"localPort"`
	Host        string  `json:"host"`
	FirstUs     int64   `json:"firstUs"`
	LastUs      int64   `json:"lastUs"`
	BytesUp     uint64  `json:"bytesUp"`
	BytesDown   uint64  `json:"bytesDown"`
	PktsUp      uint64  `json:"pktsUp"`
	PktsDown    uint64  `json:"pktsDown"`
	DeltaUp     uint64  `json:"dUp"` // since the last batch, for the per-minute rollups
	DeltaDown   uint64  `json:"dDown"`
	DeltaPkts   uint64  `json:"dPkts"`
	DeltaPktsUp uint64  `json:"dPktsUp"`
	RTTms       float64 `json:"rttMs"`
	Open        bool    `json:"open"`
	Plaintext   bool    `json:"plaintext"`
	System      bool    `json:"system"` // broadcast/multicast/icmp - traffic no process owns
}

// everything known about one remote address
type Endpoint struct {
	IP          string   `json:"ip"`
	Kind        string   `json:"kind"`
	Host        string   `json:"host"` // the best name for it: sni, dns, then ptr
	PTR         string   `json:"ptr"`
	Lat         float64  `json:"lat"`
	Lon         float64  `json:"lon"`
	Located     bool     `json:"located"`
	City        string   `json:"city"`
	Region      string   `json:"region"`
	Country     string   `json:"country"`
	CountryCode string   `json:"countryCode"`
	ASN         uint32   `json:"asn"`
	Org         string   `json:"org"`
	Owner       string   `json:"owner"`
	Categories  []string `json:"categories"`
	Tracker     bool     `json:"tracker"`
	RTTms       float64  `json:"rttMs"`    // the best round trip seen to it
	Possible    bool     `json:"possible"` // whether the geo-ip location fits that rtt
	DrawnLat    float64  `json:"drawnLat"` // where to draw it - pulled in when it's impossible
	DrawnLon    float64  `json:"drawnLon"`
	Route       string   `json:"route"` // prefix of the route it takes
}

// one traced path, shared by every address in the prefix
type Route struct {
	Prefix   string `json:"prefix"`
	Dst      string `json:"dst"`
	TracedUs int64  `json:"tracedUs"`
	Hops     []Hop  `json:"hops"`
}

type Hop struct {
	TTL      int     `json:"ttl"`
	IP       string  `json:"ip"` // "" when nothing answered
	RTTms    float64 `json:"rttMs"`
	PTR      string  `json:"ptr"`
	ASN      uint32  `json:"asn"`
	Org      string  `json:"org"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Located  bool    `json:"located"`
	City     string  `json:"city"`
	Country  string  `json:"country"`
	From     string  `json:"from"` // where the location came from: "geoip", or the code in its name
	Possible bool    `json:"possible"`
}

// what one process with a connection cost the machine over the batch, and how
// long it's been running - for the website's process stats
type ProcUsage struct {
	Pid      int32   `json:"pid"`
	Process  string  `json:"process"`
	StartUs  int64   `json:"startUs"`  // when it started, 0 if it couldn't be found
	Measured bool    `json:"measured"` // false: someone else's process - no cpu, memory or disk
	CPUms    float64 `json:"cpuMs"`    // since the last batch, every core added up
	Mem      uint64  `json:"mem"`      // its footprint now
	Disk     uint64  `json:"disk"`     // bytes read + written since the last batch
}

// Chunk is one connection's packets over one batch, 8 bytes each:
//
//	0-3  µs after T0Us (u32, little endian)
//	4-5  size on the wire, capped at 65535 (u16, little endian)
//	6    bit 7 set when sent from this machine, bits 0-6 the tcp flags
//	7    ttl / hop limit
type Chunk struct {
	Conn   uint64 `json:"conn"`
	T0Us   int64  `json:"t0"`
	N      int    `json:"n"`
	Weight uint32 `json:"w"` // each recorded packet stands for this many
	Data   string `json:"data"`
}

const RecordSize = 8

// a packet as it goes into a chunk
type Record struct {
	TimeUs int64  `json:"timeUs"`
	Size   uint32 `json:"size"`
	Out    bool   `json:"out"`
	Flags  uint8  `json:"flags"`
	TTL    uint8  `json:"ttl"`
}

// Encode packs records into a chunk, oldest first. a late-matched packet can
// arrive after newer ones, so they're sorted on the way in
func Encode(conn uint64, weight uint32, recs []Record) Chunk {
	slices.SortStableFunc(recs, func(a, b Record) int { return cmp.Compare(a.TimeUs, b.TimeUs) })
	t0 := recs[0].TimeUs
	buf := make([]byte, len(recs)*RecordSize)
	for i, r := range recs {
		b := buf[i*RecordSize:]
		binary.LittleEndian.PutUint32(b, uint32(r.TimeUs-t0))
		binary.LittleEndian.PutUint16(b[4:], uint16(min(r.Size, 0xffff)))
		b[6] = r.Flags & 0x7f
		if r.Out {
			b[6] |= 0x80
		}
		b[7] = r.TTL
	}
	return Chunk{Conn: conn, T0Us: t0, N: len(recs), Weight: weight, Data: base64.StdEncoding.EncodeToString(buf)}
}

// Decode is Encode backwards - for tests, and as the reference for the website's
// decoder (web/src/chunks.ts)
func Decode(c Chunk) ([]Record, error) {
	buf, err := base64.StdEncoding.DecodeString(c.Data)
	if err != nil {
		return nil, err
	}
	recs := make([]Record, 0, len(buf)/RecordSize)
	for i := 0; i+RecordSize <= len(buf); i += RecordSize {
		b := buf[i:]
		recs = append(recs, Record{
			TimeUs: c.T0Us + int64(binary.LittleEndian.Uint32(b)),
			Size:   uint32(binary.LittleEndian.Uint16(b[4:])),
			Out:    b[6]&0x80 != 0,
			Flags:  b[6] & 0x7f,
			TTL:    b[7],
		})
	}
	return recs, nil
}
