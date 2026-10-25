package main

import (
	"cmp"
	"math"
	"net/netip"
	"slices"
	"time"

	"upi/capture"
	"upi/enrich"
	"upi/procs"
	"upi/upload"
)

const (
	connIdle     = 10 * time.Minute // a closed connection with no traffic for this long is forgotten (it's already uploaded)
	endpointIdle = time.Hour
	retraceAfter = 6 * time.Hour
	// a trace that never came back (it failed - no answers, say) is asked for again
	// after this
	traceGiveUp = 10 * time.Minute
	maxNames    = 8192 // remembered dns answers
	// one connection's packets recorded in one batch, at most. the sampling's set
	// from the batch before, so the first batch of a burst would otherwise record
	// all of it: past this, every other one's dropped and the rest count double
	maxConnRecords = 16384
	// with no flow events there's no telling when a connection closes, so it's
	// called open while it's had traffic this recently
	scanOpenFor = 30 * time.Second
)

// one process talking to one remote address + port. several sockets (a browser
// opening six to the same server) count as one
type connKey struct {
	pid        int32 // -1 for system traffic, 0 when nothing matched
	proto      uint8
	remote     netip.Addr
	remotePort uint16
}

type conn struct {
	id                                   uint64
	key                                  connKey
	process                              string
	localPort                            uint16
	host                                 string // the server name its tls hello asked for
	firstUs, lastUs                      int64
	bytesUp, bytesDown, pktsUp, pktsDown uint64
	dUp, dDown, dPkts, dPktsUp           uint64 // since the last batch
	plaintext                            bool
	rttMs                                float64 // the latest round trip - kept once its flows are gone
	recs                                 []upload.Record
	thin                                 uint8  // this batch, 1 in 2^thin of what's sampled is recorded
	thinN                                uint32 // counting towards the next one
	dirty                                bool
}

// how sure a name is, so a better one can replace it but not the other way round
const (
	nameNone = iota
	namePTR
	nameDNS
	nameSNI
)

type endpoint struct {
	addr      netip.Addr
	requested bool // a lookup's been asked for
	info      enrich.Endpoint
	host      string
	hostFrom  int
	owner     enrich.Owner
	rttMs     float64 // the best seen to it, 0 until there's one
	possible  bool
	drawn     enrich.LatLon
	route     netip.Prefix
	lastUs    int64
	dirty     bool
}

type route struct {
	r     enrich.Route
	dirty bool
}

type state struct {
	self     int32 // our own pid - lookups, traces and uploads aren't anyone's traffic
	enricher *enrich.Enricher
	nstat    bool // flow events are coming in (vs socket scans)
	geo      bool
	iface    string
	maxPPS   int

	nextID    uint64
	conns     map[connKey]*conn
	flows     map[uint64]connKey // open flows, from flow events
	openFlows map[connKey]int
	rtt       map[connKey]float64

	endpoints map[netip.Addr]*endpoint
	names     map[netip.Addr]string // passive dns: answers seen on the wire
	nameOrder []netip.Addr
	routes    map[netip.Prefix]*route
	tracing   map[netip.Prefix]time.Time

	home      *enrich.LatLon
	homeRow   *upload.Home
	homeDirty bool

	// the burst guard: 1 in sampleEvery packets gets recorded, so a big download
	// can't blow through the database's budget. byte counts are always exact
	sampleEvery uint32
	sampleN     uint32
	batchPkts   int
	lastBatch   time.Time

	// what each process with a connection had used at the last batch
	usage     map[int32]procs.Usage
	readUsage func(pid int32) (procs.Usage, bool)
	startTime func(pid int32) int64
}

func newState(self int32, e *enrich.Enricher, iface string, nstat, geo bool, maxPPS int) *state {
	return &state{
		self: self, enricher: e, iface: iface, nstat: nstat, geo: geo, maxPPS: maxPPS,
		// ids carry the start time so they don't repeat across restarts, and stay
		// under 2^53 so javascript can hold them
		nextID:      uint64(time.Now().Unix()) * 1_000_000,
		conns:       make(map[connKey]*conn),
		flows:       make(map[uint64]connKey),
		openFlows:   make(map[connKey]int),
		rtt:         make(map[connKey]float64),
		endpoints:   make(map[netip.Addr]*endpoint),
		names:       make(map[netip.Addr]string),
		routes:      make(map[netip.Prefix]*route),
		tracing:     make(map[netip.Prefix]time.Time),
		sampleEvery: 1,
		lastBatch:   time.Now(),
		usage:       make(map[int32]procs.Usage),
		readUsage:   procs.ReadUsage,
		startTime:   procs.StartTime,
	}
}

func (s *state) packets(batch []capture.Matched) {
	for i := range batch {
		m := &batch[i]
		s.batchPkts++
		for _, n := range m.Names {
			s.learnName(n.Addr, n.Host)
		}
		if m.Proto == 0 || m.Sock.Pid == s.self {
			continue // not ip (arp etc), or our own
		}
		remote, remotePort := m.Remote()
		key := connKey{pid: m.Sock.Pid, proto: m.Proto, remote: remote, remotePort: remotePort}
		if m.System {
			key.pid = -1
		}
		c := s.conns[key]
		if c == nil {
			s.nextID++
			c = &conn{id: s.nextID, key: key, process: m.Sock.Name, firstUs: m.TimeUs, rttMs: s.rtt[key]}
			s.conns[key] = c
		}
		size := uint64(m.Size)
		if m.Dir == capture.Out {
			c.bytesUp += size
			c.pktsUp++
			c.dPktsUp++
			c.dUp += size
		} else {
			c.bytesDown += size
			c.pktsDown++
			c.dDown += size
		}
		c.dPkts++
		c.lastUs = max(c.lastUs, m.TimeUs)
		c.localPort = m.LocalPort()
		c.plaintext = c.plaintext || m.Plaintext
		c.dirty = true
		if s.sampleN%s.sampleEvery == 0 {
			if c.thinN%(1<<c.thin) == 0 {
				c.recs = append(c.recs, upload.Record{TimeUs: m.TimeUs, Size: m.Size, Out: m.Dir == capture.Out, Flags: m.Flags, TTL: m.TTL})
				if len(c.recs) >= maxConnRecords {
					c.recs = everyOther(c.recs)
					c.thin++
				}
			}
			c.thinN++
		}
		s.sampleN++

		ep := s.endpoint(remote)
		ep.lastUs = max(ep.lastUs, m.TimeUs)
		// a round trip that came in before there was an endpoint for it
		if c.rttMs > 0 && (ep.rttMs == 0 || c.rttMs < ep.rttMs) {
			ep.rttMs = c.rttMs
			s.physics(ep)
		}
		if m.SNI != "" {
			c.host = m.SNI
			s.nameEndpoint(ep, m.SNI, nameSNI)
		}
	}
}

// the 1st, 3rd, 5th... - in place
func everyOther(recs []upload.Record) []upload.Record {
	n := 0
	for i := 0; i < len(recs); i += 2 {
		recs[n] = recs[i]
		n++
	}
	return recs[:n]
}

func (s *state) learnName(a netip.Addr, host string) {
	if _, known := s.names[a]; !known {
		s.nameOrder = append(s.nameOrder, a)
	}
	s.names[a] = host
	for len(s.nameOrder) > maxNames {
		delete(s.names, s.nameOrder[0])
		s.nameOrder = s.nameOrder[1:]
	}
	if ep := s.endpoints[a]; ep != nil {
		s.nameEndpoint(ep, host, nameDNS)
	}
}

// the endpoint for an address, asking for it to be looked up the first time
func (s *state) endpoint(a netip.Addr) *endpoint {
	ep := s.endpoints[a]
	if ep == nil {
		ep = &endpoint{addr: a, info: enrich.Endpoint{Addr: a, Kind: enrich.Classify(a)}, possible: true, dirty: true}
		s.endpoints[a] = ep
		if host, ok := s.names[a]; ok {
			s.nameEndpoint(ep, host, nameDNS)
		}
	}
	if !ep.requested && ep.info.Kind == enrich.Public {
		ep.requested = s.enricher.Lookup(a)
	}
	return ep
}

func (s *state) nameEndpoint(ep *endpoint, host string, from int) {
	if from < ep.hostFrom || host == ep.host {
		return
	}
	ep.host, ep.hostFrom = host, from
	s.findOwner(ep)
	ep.dirty = true
}

// who's behind an endpoint: the company that owns its name, or failing that
// whoever runs the network it's on
func (s *state) findOwner(ep *endpoint) {
	if o, ok := enrich.OwnerOf(ep.host); ok {
		ep.owner = o
		return
	}
	ep.owner = enrich.Owner{Name: ep.info.Network.Org}
}

func (s *state) flow(ev procs.Event) {
	switch ev.Kind {
	case procs.Flow:
		sock := ev.Sock
		if !sock.Connected() || sock.Pid == s.self {
			return
		}
		key := connKey{pid: sock.Pid, proto: uint8(sock.Proto), remote: sock.RemoteAddr, remotePort: sock.RemotePort}
		if old, had := s.flows[ev.ID]; had {
			if old == key {
				return
			}
			s.closeFlow(ev.ID)
		}
		s.flows[ev.ID] = key
		s.openFlows[key]++
		if c := s.conns[key]; c != nil {
			c.dirty = true
		}
	case procs.Removed:
		s.closeFlow(ev.ID)
	case procs.Stats:
		key, ok := s.flows[ev.ID]
		if !ok {
			return
		}
		s.rtt[key] = ev.RTTms
		if c := s.conns[key]; c != nil {
			c.rttMs = ev.RTTms
			c.dirty = true
		}
		if ep := s.endpoints[key.remote]; ep != nil && (ep.rttMs == 0 || ev.RTTms < ep.rttMs) {
			ep.rttMs = ev.RTTms
			s.physics(ep)
		}
	}
}

func (s *state) closeFlow(id uint64) {
	key, ok := s.flows[id]
	if !ok {
		return
	}
	delete(s.flows, id)
	if s.openFlows[key]--; s.openFlows[key] <= 0 {
		delete(s.openFlows, key)
		delete(s.rtt, key)
	}
	if c := s.conns[key]; c != nil {
		c.dirty = true
	}
}

func (s *state) enriched(v any) {
	switch r := v.(type) {
	case enrich.Endpoint:
		ep := s.endpoints[r.Addr]
		if ep == nil {
			return // forgotten while it was being looked up
		}
		ep.info = r
		if r.PTR != "" {
			s.nameEndpoint(ep, r.PTR, namePTR)
		}
		if ep.owner.Name == "" {
			s.findOwner(ep)
		}
		s.physics(ep)
		ep.dirty = true
		s.maybeTrace(r.Addr)
	case enrich.Route:
		delete(s.tracing, r.Prefix)
		s.routes[r.Prefix] = &route{r: r, dirty: true}
		for a, ep := range s.endpoints {
			if r.Prefix.Contains(a) {
				ep.route = r.Prefix
				if last := r.Hops[len(r.Hops)-1]; last.Addr == a && (ep.rttMs == 0 || last.RTTms < ep.rttMs) {
					ep.rttMs = last.RTTms
				}
				s.physics(ep)
			}
		}
	}
}

// one trace per block of addresses, again every few hours - paths change, but
// not that often
func (s *state) maybeTrace(a netip.Addr) {
	p := enrich.RoutePrefix(a)
	if r, ok := s.routes[p]; ok {
		if ep := s.endpoints[a]; ep != nil {
			ep.route = p
		}
		if time.Since(r.r.At) < retraceAfter {
			return
		}
	}
	if asked, pending := s.tracing[p]; pending && time.Since(asked) < traceGiveUp {
		return
	}
	if s.enricher.Trace(a) {
		s.tracing[p] = time.Now()
	}
}

// checks an endpoint's geo-ip location against how fast it answers. too far
// away to answer that fast means it's somewhere else (usually anycast) - it gets
// flagged, and drawn at the last router on its way that does fit, or failing
// that a short way towards where the database claims
func (s *state) physics(ep *endpoint) {
	ep.drawn, ep.possible = ep.info.Place.LatLon, true
	ep.dirty = true
	if s.home == nil || !ep.info.Located || ep.rttMs <= 0 {
		return
	}
	if ep.possible = enrich.Possible(*s.home, ep.info.Place.LatLon, ep.rttMs); ep.possible {
		return
	}
	if r, ok := s.routes[ep.route]; ok {
		for i := len(r.r.Hops) - 1; i >= 0; i-- {
			if h := r.r.Hops[i]; h.Located && h.Possible && enrich.Possible(*s.home, h.Place.LatLon, ep.rttMs) {
				ep.drawn = h.Place.LatLon
				return
			}
		}
	}
	ep.drawn = enrich.Toward(*s.home, ep.info.Place.LatLon, min(enrich.MaxKm(ep.rttMs)/2, 500))
}

func (s *state) setHome(h upload.Home) {
	s.home = &enrich.LatLon{Lat: h.Lat, Lon: h.Lon}
	s.homeRow, s.homeDirty = &h, true
	s.enricher.SetHome(*s.home)
	for _, ep := range s.endpoints {
		s.physics(ep)
	}
}

// batch collects everything that changed since the last one, and forgets
// whatever's been idle long enough
func (s *state) batch(now time.Time, dropped int) *upload.Batch {
	nowUs := now.UnixMicro()
	pps := float64(s.batchPkts) / max(now.Sub(s.lastBatch).Seconds(), 0.001)
	b := &upload.Batch{
		TimeUs:    nowUs,
		Stats:     upload.Stats{Iface: s.iface, PPS: math.Round(pps*10) / 10, Dropped: dropped, Nstat: s.nstat, Geo: s.geo, Sampled: s.sampleEvery},
		Conns:     []upload.Conn{},
		Endpoints: []upload.Endpoint{},
		Routes:    []upload.Route{},
		Chunks:    []upload.Chunk{},
		Procs:     []upload.ProcUsage{},
	}
	if s.homeDirty {
		b.Home, s.homeDirty = s.homeRow, false
	}

	for key, c := range s.conns {
		if !c.dirty {
			if now.Sub(time.UnixMicro(c.lastUs)) > connIdle && s.openFlows[key] == 0 {
				delete(s.conns, key)
			}
			continue
		}
		b.Conns = append(b.Conns, s.connRow(c, nowUs))
		if len(c.recs) > 0 {
			b.Chunks = append(b.Chunks, upload.Encode(c.id, s.sampleEvery<<c.thin, c.recs))
			c.recs = c.recs[:0]
		}
		c.thin, c.thinN = 0, 0
		c.dUp, c.dDown, c.dPkts, c.dPktsUp, c.dirty = 0, 0, 0, 0, false
	}
	b.Procs = s.procUsage()
	used := make(map[netip.Prefix]bool) // routes something still goes along
	for a, ep := range s.endpoints {
		if ep.dirty && ep.lastUs > 0 {
			b.Endpoints = append(b.Endpoints, endpointRow(ep))
			ep.dirty = false
		} else if now.Sub(time.UnixMicro(ep.lastUs)) > endpointIdle {
			delete(s.endpoints, a)
			continue
		}
		// anything still talking keeps its route fresh (traced again every few hours),
		// and a trace that couldn't be asked for before - the queue was full - is now
		if ep.info.Kind == enrich.Public && ep.lastUs >= s.lastBatch.UnixMicro() {
			s.maybeTrace(a)
		}
		used[ep.route] = true
	}
	for p, r := range s.routes {
		if r.dirty {
			b.Routes = append(b.Routes, routeRow(r.r))
			r.dirty = false
		} else if !used[p] && now.Sub(r.r.At) > retraceAfter {
			delete(s.routes, p) // it's uploaded, and traced again if it's needed
		}
	}
	for p, asked := range s.tracing {
		if now.Sub(asked) > traceGiveUp {
			delete(s.tracing, p)
		}
	}

	// the guard for the next batch comes from this one's rate
	s.sampleEvery = 1
	if s.maxPPS > 0 && pps > float64(s.maxPPS) {
		s.sampleEvery = uint32(math.Ceil(pps / float64(s.maxPPS)))
	}
	s.batchPkts, s.lastBatch = 0, now
	return b
}

// what every process with a connection used since the last batch, and when it
// started. the first time one's seen there's nothing to compare with, so it's
// only its memory; root's processes only say when they started
func (s *state) procUsage() []upload.ProcUsage {
	names := make(map[int32]string)
	for k, c := range s.conns {
		if k.pid > 0 {
			names[k.pid] = c.process
		}
	}
	out := []upload.ProcUsage{}
	seen := make(map[int32]procs.Usage, len(names))
	for pid, name := range names {
		row := upload.ProcUsage{Pid: pid, Process: name, StartUs: s.startTime(pid)}
		if u, ok := s.readUsage(pid); ok {
			seen[pid] = u
			row.Measured, row.Mem = true, u.Footprint
			// a pid that's gone backwards was reused by a new process
			if prev, ok := s.usage[pid]; ok && u.CPU >= prev.CPU && u.Disk >= prev.Disk {
				row.CPUms = float64(u.CPU-prev.CPU) / float64(time.Millisecond)
				row.Disk = u.Disk - prev.Disk
			}
		}
		if row.Measured || row.StartUs > 0 {
			out = append(out, row)
		}
	}
	s.usage = seen
	slices.SortFunc(out, func(a, b upload.ProcUsage) int { return cmp.Compare(a.Pid, b.Pid) })
	return out
}

func (s *state) connRow(c *conn, nowUs int64) upload.Conn {
	open := s.openFlows[c.key] > 0
	if !s.nstat {
		open = nowUs-c.lastUs < scanOpenFor.Microseconds()
	}
	remote := ""
	if c.key.remote.IsValid() {
		remote = c.key.remote.String()
	}
	return upload.Conn{
		ID: c.id, Pid: c.key.pid, Process: c.process, Proto: c.key.proto,
		RemoteIP: remote, RemotePort: c.key.remotePort, LocalPort: c.localPort, Host: c.host,
		FirstUs: c.firstUs, LastUs: c.lastUs,
		BytesUp: c.bytesUp, BytesDown: c.bytesDown, PktsUp: c.pktsUp, PktsDown: c.pktsDown,
		DeltaUp: c.dUp, DeltaDown: c.dDown, DeltaPkts: c.dPkts, DeltaPktsUp: c.dPktsUp,
		RTTms: c.rttMs, Open: open, Plaintext: c.plaintext, System: c.key.pid == -1,
	}
}

func endpointRow(ep *endpoint) upload.Endpoint {
	i := ep.info
	row := upload.Endpoint{
		IP: ep.addr.String(), Kind: i.Kind.String(), Host: ep.host, PTR: i.PTR,
		Lat: i.Place.Lat, Lon: i.Place.Lon, Located: i.Located,
		City: i.Place.City, Region: i.Place.Region, Country: i.Place.Country, CountryCode: i.Place.CountryCode,
		ASN: i.Network.ASN, Org: i.Network.Org,
		Owner: ep.owner.Name, Categories: ep.owner.Categories, Tracker: ep.owner.Tracker,
		RTTms: ep.rttMs, Possible: ep.possible, DrawnLat: ep.drawn.Lat, DrawnLon: ep.drawn.Lon,
	}
	if row.Categories == nil {
		row.Categories = []string{}
	}
	if ep.route.IsValid() {
		row.Route = ep.route.String()
	}
	return row
}

func routeRow(r enrich.Route) upload.Route {
	row := upload.Route{Prefix: r.Prefix.String(), Dst: r.Dst.String(), TracedUs: r.At.UnixMicro(), Hops: []upload.Hop{}}
	for _, h := range r.Hops {
		hop := upload.Hop{
			TTL: h.TTL, RTTms: h.RTTms, PTR: h.PTR, ASN: h.Network.ASN, Org: h.Network.Org,
			Lat: h.Place.Lat, Lon: h.Place.Lon, Located: h.Located, City: h.Place.City,
			Country: h.Place.CountryCode, From: h.From, Possible: h.Possible,
		}
		if h.Addr.IsValid() {
			hop.IP = h.Addr.String()
		}
		row.Hops = append(row.Hops, hop)
	}
	return row
}
