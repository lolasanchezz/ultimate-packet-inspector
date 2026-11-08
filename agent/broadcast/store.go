// Package broadcast is how the desktop app sees what the agent sees. Store keeps
// the rolling state the app draws from - connections, endpoints, per-minute
// traffic and so on - and Server streams it to every app that's listening on
// this machine: everything at once when one connects, then what each batch
// changed
package broadcast

import (
	"encoding/json"
	"fmt"
	"math"
	"time"

	"upi/wire"
)

const (
	second = int64(time.Second / time.Microsecond) // timestamps are µs since the epoch
	minute = 60 * second
	hour   = 60 * minute

	LiveChunksFor = 30 * second // how far back the live view's packets go
	// the app's longest period is a day - and a little, for its chart's first bar
	HistoryFor = 26 * hour
	// routes are traced every few hours, so one from before the window still applies
	RoutesFor = HistoryFor + 6*hour
)

// the one machine - the app's rows carry its id, and keys start with it, so the
// app can tell one machine's rows from another's if there's ever more than one
const machineID = 1

type Machine struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	Iface       string  `json:"iface"`
	HomeLat     float64 `json:"homeLat"`
	HomeLon     float64 `json:"homeLon"`
	HomePlace   string  `json:"homePlace"`
	LastSeenUs  int64   `json:"lastSeenUs"`
	PPS         float64 `json:"pps"`
	Dropped     int64   `json:"dropped"`
	Nstat       bool    `json:"nstat"`
	Geo         bool    `json:"geo"`
	Sampled     uint32  `json:"sampled"`
	LastBatchUs int64   `json:"lastBatchUs"`
}

type Conn struct {
	Key        string  `json:"key"`
	MachineID  int     `json:"machineId"`
	ConnID     uint64  `json:"connId"`
	Pid        int32   `json:"pid"`
	Process    string  `json:"process"`
	Proto      uint8   `json:"proto"`
	RemoteIP   string  `json:"remoteIp"`
	RemotePort uint16  `json:"remotePort"`
	LocalPort  uint16  `json:"localPort"`
	Host       string  `json:"host"`
	FirstUs    int64   `json:"firstUs"`
	LastUs     int64   `json:"lastUs"`
	BytesUp    float64 `json:"bytesUp"`
	BytesDown  float64 `json:"bytesDown"`
	PktsUp     float64 `json:"pktsUp"`
	PktsDown   float64 `json:"pktsDown"`
	RTTms      float64 `json:"rttMs"`
	Open       bool    `json:"open"`
	Plaintext  bool    `json:"plaintext"`
	System     bool    `json:"system"`
}

type Endpoint struct {
	Key       string `json:"key"`
	MachineID int    `json:"machineId"`
	wire.Endpoint
	LastUs int64 `json:"lastUs"`
}

type Route struct {
	Key       string `json:"key"`
	MachineID int    `json:"machineId"`
	Prefix    string `json:"prefix"`
	Dst       string `json:"dst"`
	TracedUs  int64  `json:"tracedUs"`
	Hops      string `json:"hops"` // json - see wire.Hop
}

type Chunk struct {
	ID        uint64 `json:"id"`
	MachineID int    `json:"machineId"`
	ConnID    uint64 `json:"connId"`
	T0Us      int64  `json:"t0Us"`
	N         int    `json:"n"`
	Weight    uint32 `json:"weight"`
	Data      string `json:"data"`
}

// a connection's bytes per minute
type Rollup struct {
	Key       string  `json:"key"`
	MachineID int     `json:"machineId"`
	ConnID    uint64  `json:"connId"`
	MinuteUs  int64   `json:"minuteUs"`
	BytesUp   float64 `json:"bytesUp"`
	BytesDown float64 `json:"bytesDown"`
	Pkts      float64 `json:"pkts"`
	PktsUp    float64 `json:"pktsUp"`
}

// the whole machine's traffic per minute
type Traffic struct {
	Key       string  `json:"key"`
	MachineID int     `json:"machineId"`
	MinuteUs  int64   `json:"minuteUs"`
	BytesUp   float64 `json:"bytesUp"`
	BytesDown float64 `json:"bytesDown"`
	Pkts      float64 `json:"pkts"`
}

// what a process with a connection cost the machine in a minute
type ProcUsage struct {
	Key       string  `json:"key"`
	MachineID int     `json:"machineId"`
	Pid       int32   `json:"pid"`
	Process   string  `json:"process"`
	MinuteUs  int64   `json:"minuteUs"`
	CPUms     float64 `json:"cpuMs"`
	MemBytes  float64 `json:"memBytes"`
	DiskBytes float64 `json:"diskBytes"`
}

// when a process with a connection started
type Proc struct {
	Key       string `json:"key"`
	MachineID int    `json:"machineId"`
	Pid       int32  `json:"pid"`
	Process   string `json:"process"`
	StartUs   int64  `json:"startUs"`
	LastUs    int64  `json:"lastUs"`
}

// Rows is the whole state, or what one batch changed. the app keeps its own copy
// and lets rows go by the same rules prune does, so nothing here says what's gone
type Rows struct {
	Machine   *Machine     `json:"machine,omitempty"`
	Conns     []*Conn      `json:"conns"`
	Endpoints []*Endpoint  `json:"endpoints"`
	Routes    []*Route     `json:"routes"`
	Chunks    []*Chunk     `json:"chunks"`
	Rollups   []*Rollup    `json:"rollups"`
	Traffic   []*Traffic   `json:"traffic"`
	ProcUsage []*ProcUsage `json:"procUsage"`
	Procs     []*Proc      `json:"procs"`
}

// Store isn't safe to share - Server keeps it behind a lock
type Store struct {
	machine   Machine
	conns     map[string]*Conn
	endpoints map[string]*Endpoint
	routes    map[string]*Route
	chunks    []*Chunk // oldest first
	rollups   map[string]*Rollup
	traffic   map[string]*Traffic
	procUsage map[string]*ProcUsage
	procs     map[string]*Proc
	chunkID   uint64
}

func NewStore(name, iface string) *Store {
	return &Store{
		machine:   Machine{ID: machineID, Name: name, Iface: iface, Sampled: 1},
		conns:     map[string]*Conn{},
		endpoints: map[string]*Endpoint{},
		routes:    map[string]*Route{},
		rollups:   map[string]*Rollup{},
		traffic:   map[string]*Traffic{},
		procUsage: map[string]*ProcUsage{},
		procs:     map[string]*Proc{},
	}
}

func key(parts ...any) string {
	s := fmt.Sprint(machineID)
	for _, p := range parts {
		s += "/" + fmt.Sprint(p)
	}
	return s
}

// Ingest takes in a batch, and returns the rows it changed
func (s *Store) Ingest(b *wire.Batch, now time.Time) Rows {
	nowUs := now.UnixMicro()
	var out Rows
	m := &s.machine
	m.LastSeenUs, m.LastBatchUs = nowUs, b.TimeUs
	if b.Stats.Iface != "" {
		m.Iface = b.Stats.Iface
	}
	m.PPS, m.Dropped, m.Nstat, m.Geo, m.Sampled = b.Stats.PPS, int64(b.Stats.Dropped), b.Stats.Nstat, b.Stats.Geo, max(1, b.Stats.Sampled)
	if b.Home != nil {
		m.HomeLat, m.HomeLon, m.HomePlace = b.Home.Lat, b.Home.Lon, b.Home.Place
	}
	machine := *m
	out.Machine = &machine

	minuteUs := b.TimeUs / minute * minute
	var up, down, pkts float64
	for _, c := range b.Conns {
		row := &Conn{
			Key: key(c.ID), MachineID: machineID, ConnID: c.ID, Pid: c.Pid, Process: c.Process, Proto: c.Proto,
			RemoteIP: c.RemoteIP, RemotePort: c.RemotePort, LocalPort: c.LocalPort, Host: c.Host,
			FirstUs: c.FirstUs, LastUs: c.LastUs,
			BytesUp: float64(c.BytesUp), BytesDown: float64(c.BytesDown), PktsUp: float64(c.PktsUp), PktsDown: float64(c.PktsDown),
			RTTms: finite(c.RTTms), Open: c.Open, Plaintext: c.Plaintext, System: c.System,
		}
		s.conns[row.Key] = row
		out.Conns = append(out.Conns, row)

		// keep the endpoint showing as long as something's talking to it
		if ep := s.endpoints[key(c.RemoteIP)]; ep != nil && ep.LastUs < row.LastUs {
			ep.LastUs = row.LastUs
			out.Endpoints = append(out.Endpoints, ep)
		}

		dUp, dDown, dPkts := float64(c.DeltaUp), float64(c.DeltaDown), float64(c.DeltaPkts)
		if dUp+dDown+dPkts > 0 {
			k := key(c.ID, minuteUs)
			r := s.rollups[k]
			if r == nil {
				r = &Rollup{Key: k, MachineID: machineID, ConnID: c.ID, MinuteUs: minuteUs}
				s.rollups[k] = r
			}
			r.BytesUp += dUp
			r.BytesDown += dDown
			r.Pkts += dPkts
			r.PktsUp += float64(c.DeltaPktsUp)
			out.Rollups = append(out.Rollups, r)
			up, down, pkts = up+dUp, down+dDown, pkts+dPkts
		}
	}
	if up+down+pkts > 0 {
		k := key(minuteUs)
		t := s.traffic[k]
		if t == nil {
			t = &Traffic{Key: k, MachineID: machineID, MinuteUs: minuteUs}
			s.traffic[k] = t
		}
		t.BytesUp += up
		t.BytesDown += down
		t.Pkts += pkts
		out.Traffic = append(out.Traffic, t)
	}

	for _, p := range b.Procs {
		if p.Pid <= 0 {
			continue
		}
		if p.StartUs > 0 {
			row := &Proc{Key: key(p.Pid), MachineID: machineID, Pid: p.Pid, Process: p.Process, StartUs: p.StartUs, LastUs: b.TimeUs}
			s.procs[row.Key] = row
			out.Procs = append(out.Procs, row)
		}
		if !p.Measured {
			continue
		}
		k := key(p.Pid, minuteUs)
		u := s.procUsage[k]
		if u == nil {
			u = &ProcUsage{Key: k, MachineID: machineID, Pid: p.Pid, Process: p.Process, MinuteUs: minuteUs}
			s.procUsage[k] = u
		}
		u.CPUms += finite(p.CPUms)
		u.MemBytes = math.Max(u.MemBytes, float64(p.Mem))
		u.DiskBytes += float64(p.Disk)
		out.ProcUsage = append(out.ProcUsage, u)
	}

	for _, e := range b.Endpoints {
		k := key(e.IP)
		row := &Endpoint{Key: k, MachineID: machineID, Endpoint: e, LastUs: b.TimeUs}
		if row.Categories == nil {
			row.Categories = []string{}
		}
		if old := s.endpoints[k]; old != nil && old.LastUs > row.LastUs {
			row.LastUs = old.LastUs
		}
		s.endpoints[k] = row
		out.Endpoints = append(out.Endpoints, row)
	}

	for _, r := range b.Routes {
		hops, _ := json.Marshal(r.Hops)
		if r.Hops == nil {
			hops = []byte("[]")
		}
		row := &Route{Key: key(r.Prefix), MachineID: machineID, Prefix: r.Prefix, Dst: r.Dst, TracedUs: r.TracedUs, Hops: string(hops)}
		s.routes[row.Key] = row
		out.Routes = append(out.Routes, row)
	}

	for _, c := range b.Chunks {
		if c.Data == "" {
			continue
		}
		s.chunkID++
		row := &Chunk{ID: s.chunkID, MachineID: machineID, ConnID: c.Conn, T0Us: c.T0Us, N: c.N, Weight: max(1, c.Weight), Data: c.Data}
		s.chunks = append(s.chunks, row)
		out.Chunks = append(out.Chunks, row)
	}
	s.prune(nowUs)
	return out.dedupe()
}

// lets go of everything older than the app ever looks
func (s *Store) prune(nowUs int64) {
	i := 0
	for i < len(s.chunks) && s.chunks[i].T0Us < nowUs-LiveChunksFor {
		i++
	}
	s.chunks = append(s.chunks[:0:0], s.chunks[i:]...)
	old := nowUs - HistoryFor
	pruneMap(s.conns, func(c *Conn) bool { return c.LastUs < old })
	pruneMap(s.endpoints, func(e *Endpoint) bool { return e.LastUs < old })
	pruneMap(s.routes, func(r *Route) bool { return r.TracedUs < nowUs-RoutesFor })
	pruneMap(s.rollups, func(r *Rollup) bool { return r.MinuteUs < old })
	pruneMap(s.traffic, func(t *Traffic) bool { return t.MinuteUs < old })
	pruneMap(s.procUsage, func(u *ProcUsage) bool { return u.MinuteUs < old })
	pruneMap(s.procs, func(p *Proc) bool { return p.LastUs < old })
}

func pruneMap[T any](m map[string]*T, gone func(*T) bool) {
	for k, v := range m {
		if gone(v) {
			delete(m, k)
		}
	}
}

// All is everything there is, for an app that's just connected
func (s *Store) All() Rows {
	m := s.machine
	return Rows{
		Machine:   &m,
		Conns:     values(s.conns),
		Endpoints: values(s.endpoints),
		Routes:    values(s.routes),
		Chunks:    append([]*Chunk{}, s.chunks...),
		Rollups:   values(s.rollups),
		Traffic:   values(s.traffic),
		ProcUsage: values(s.procUsage),
		Procs:     values(s.procs),
	}
}

func values[T any](m map[string]*T) []*T {
	out := make([]*T, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

// a row changed twice in a batch is sent once. the rows are pointers into the
// store, so each is already at its latest
func (r Rows) dedupe() Rows {
	r.Endpoints = uniq(r.Endpoints, func(e *Endpoint) string { return e.Key })
	r.Rollups = uniq(r.Rollups, func(x *Rollup) string { return x.Key })
	r.ProcUsage = uniq(r.ProcUsage, func(x *ProcUsage) string { return x.Key })
	r.Conns = uniq(r.Conns, func(x *Conn) string { return x.Key })
	r.Procs = uniq(r.Procs, func(x *Proc) string { return x.Key })
	r.Routes = uniq(r.Routes, func(x *Route) string { return x.Key })
	return r
}

func uniq[T any](rows []*T, k func(*T) string) []*T {
	seen := make(map[string]bool, len(rows))
	out := rows[:0]
	for _, r := range rows {
		if key := k(r); !seen[key] {
			seen[key] = true
			out = append(out, r)
		}
	}
	return out
}

// NaN and ±Inf aren't json
func finite(f float64) float64 {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return f
}
