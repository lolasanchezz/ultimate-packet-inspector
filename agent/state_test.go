package main

import (
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"upi/capture"
	"upi/enrich"
	"upi/procs"
	"upi/upload"
)

var (
	sf      = enrich.LatLon{Lat: 37.77, Lon: -122.42}
	sydney  = enrich.LatLon{Lat: -33.87, Lon: 151.21}
	sanJose = enrich.LatLon{Lat: 37.34, Lon: -121.89}
	anycast = netip.MustParseAddr("1.1.1.1")
	ourAddr = netip.MustParseAddr("10.0.0.20")
)

func testState() *state {
	s := newState(1, enrich.NewEnricher(nil), "en0", true, true, 0)
	s.setHome(upload.Home{Lat: sf.Lat, Lon: sf.Lon})
	// test pids are made up - don't read whatever's really running as them
	s.readUsage = func(int32) (procs.Usage, bool) { return procs.Usage{}, false }
	s.startTime = func(int32) int64 { return 0 }
	return s
}

func packet(pid int32, out bool, size uint32, at int64) capture.Matched {
	p := capture.Packet{TimeUs: at, Size: size, Proto: capture.TCP, Src: anycast, Dst: ourAddr, SrcPort: 443, DstPort: 50000}
	if out {
		p.Dir, p.Src, p.Dst, p.SrcPort, p.DstPort = capture.Out, ourAddr, anycast, 50000, 443
	}
	return capture.Matched{Packet: p, Sock: procs.Sock{Pid: pid, Name: "curl"}}
}

func TestConnsAddUp(t *testing.T) {
	s := testState()
	now := time.Now().UnixMicro()
	s.packets([]capture.Matched{packet(7, true, 100, now), packet(7, false, 1500, now+10), packet(7, false, 1500, now+20)})
	s.packets([]capture.Matched{packet(1, true, 999, now+30)}) // our own - ignored
	b := s.batch(time.Now(), 0)
	if len(b.Conns) != 1 {
		t.Fatalf("want one conn, got %+v", b.Conns)
	}
	c := b.Conns[0]
	if c.Process != "curl" || c.BytesUp != 100 || c.BytesDown != 3000 || c.PktsDown != 2 || c.DeltaPkts != 3 {
		t.Errorf("conn: %+v", c)
	}
	if len(b.Chunks) != 1 || b.Chunks[0].N != 3 || b.Chunks[0].Weight != 1 {
		t.Errorf("every packet should be recorded: %+v", b.Chunks)
	}
	// nothing new - nothing sent
	if b := s.batch(time.Now(), 0); len(b.Conns) != 0 || len(b.Chunks) != 0 {
		t.Errorf("an idle conn shouldn't be resent: %+v", b.Conns)
	}
}

func TestSamplingAboveMaxPPS(t *testing.T) {
	s := testState()
	s.maxPPS = 100
	now := time.Now()
	s.lastBatch = now.Add(-time.Second)
	var burst []capture.Matched
	for i := range 1000 {
		burst = append(burst, packet(7, false, 1500, now.UnixMicro()+int64(i)))
	}
	s.packets(burst)
	s.batch(now, 0) // 1000pps against a limit of 100 - the next batch samples 1 in 10
	s.lastBatch = now
	s.packets(burst)
	b := s.batch(now.Add(time.Second), 0)
	if b.Stats.Sampled != 10 || len(b.Chunks) != 1 || b.Chunks[0].Weight != 10 || b.Chunks[0].N != 100 {
		t.Errorf("want 100 records weighted 10, got %d weighted %d (sampled %d)", b.Chunks[0].N, b.Chunks[0].Weight, b.Stats.Sampled)
	}
	if b.Conns[0].DeltaDown != 1000*1500 {
		t.Error("byte counts should stay exact while sampling")
	}
}

func TestImpossibleEndpointDrawnAtLastGoodHop(t *testing.T) {
	s := testState()
	s.packets([]capture.Matched{packet(7, true, 100, time.Now().UnixMicro())})
	ep := s.endpoints[anycast]
	// geo-ip says sydney, but it answers in 3ms
	s.enriched(enrich.Endpoint{Addr: anycast, Kind: enrich.Public, Located: true, Place: enrich.Place{LatLon: sydney, City: "Sydney"}})
	s.flows[1] = connKey{pid: 7, proto: capture.TCP, remote: anycast, remotePort: 443}
	s.flow(procs.Event{Kind: procs.Stats, ID: 1, RTTms: 3})
	if ep.possible {
		t.Fatal("3ms from san francisco can't be sydney")
	}
	if enrich.DistanceKm(sf, ep.drawn) > 500 {
		t.Errorf("drawn %.0fkm away - should stay close until there's a route", enrich.DistanceKm(sf, ep.drawn))
	}

	s.enriched(enrich.Route{Prefix: enrich.RoutePrefix(anycast), Dst: anycast, At: time.Now(), Hops: []enrich.RouteHop{
		{Hop: enrich.Hop{TTL: 1, Addr: netip.MustParseAddr("10.0.0.1"), RTTms: 1}},
		{Hop: enrich.Hop{TTL: 2, Addr: netip.MustParseAddr("172.68.188.133"), RTTms: 2.5}, Located: true, Possible: true, Place: enrich.Place{LatLon: sanJose}},
		{Hop: enrich.Hop{TTL: 3, Addr: anycast, RTTms: 3}, Located: false},
	}})
	if ep.drawn != sanJose {
		t.Errorf("should be drawn at the last hop that fits, got %+v", ep.drawn)
	}
}

// a whole batch as the agent sends it, for the module's tests to ingest
// (module/src/index.test.ts) - so the two sides can't drift apart. run with
// UPDATE_FIXTURE=1 to rewrite it
func TestBatchFixture(t *testing.T) {
	s := testState()
	at := int64(1_800_000_000_000_000)
	s.nextID = 1_800_000_000_000_000
	s.packets([]capture.Matched{packet(7, true, 120, at), packet(7, false, 1500, at+800)})
	s.enriched(enrich.Endpoint{Addr: anycast, Kind: enrich.Public, Located: true, Network: enrich.Network{ASN: 13335, Org: "Cloudflare, Inc."},
		Place: enrich.Place{LatLon: sydney, City: "Sydney", Country: "Australia", CountryCode: "AU"}, PTR: "one.one.one.one"})
	s.enriched(enrich.Route{Prefix: enrich.RoutePrefix(anycast), Dst: anycast, At: time.UnixMicro(at), Hops: []enrich.RouteHop{
		{Hop: enrich.Hop{TTL: 1, Addr: netip.MustParseAddr("10.0.0.1"), RTTms: 2}},
		{Hop: enrich.Hop{TTL: 2, Addr: anycast, RTTms: 4}, Located: true, Possible: true, Place: enrich.Place{LatLon: sanJose}},
	}})
	b := s.batch(time.UnixMicro(at+2_000_000), 0)
	b.TimeUs = at + 2_000_000
	data, _ := json.MarshalIndent(b, "", "  ")
	path := filepath.Join("..", "testdata", "batch.json")
	if os.Getenv("UPDATE_FIXTURE") != "" {
		if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v - run with UPDATE_FIXTURE=1 to make it", err)
	}
	if string(saved) != string(data)+"\n" {
		t.Error("testdata/batch.json is out of date with the agent - run with UPDATE_FIXTURE=1")
	}
}

func TestProcUsageIsSinceTheLastBatch(t *testing.T) {
	s := testState()
	used := map[int32]procs.Usage{7: {CPU: 2 * time.Second, Footprint: 50 << 20, Disk: 1000}}
	s.readUsage = func(pid int32) (procs.Usage, bool) { u, ok := used[pid]; return u, ok }
	s.startTime = func(pid int32) int64 { return int64(pid) * 1000 }
	s.packets([]capture.Matched{packet(7, true, 100, time.Now().UnixMicro()), packet(8, true, 100, time.Now().UnixMicro())})
	b := s.batch(time.Now(), 0)
	// 7's first sample has nothing to compare with; 8 isn't ours to read, so it's only when it started
	want := []upload.ProcUsage{{Pid: 7, Process: "curl", StartUs: 7000, Measured: true, Mem: 50 << 20}, {Pid: 8, Process: "curl", StartUs: 8000}}
	if !slices.Equal(b.Procs, want) {
		t.Fatalf("first batch: %+v", b.Procs)
	}
	used[7] = procs.Usage{CPU: 2*time.Second + 250*time.Millisecond, Footprint: 60 << 20, Disk: 5000}
	b = s.batch(time.Now(), 0)
	if b.Procs[0] != (upload.ProcUsage{Pid: 7, Process: "curl", StartUs: 7000, Measured: true, CPUms: 250, Mem: 60 << 20, Disk: 4000}) {
		t.Errorf("second batch: %+v", b.Procs)
	}
}

func TestPacketsSentAreCounted(t *testing.T) {
	s := testState()
	now := time.Now().UnixMicro()
	s.packets([]capture.Matched{packet(7, true, 100, now), packet(7, true, 100, now+1), packet(7, false, 1500, now+2)})
	c := s.batch(time.Now(), 0).Conns[0]
	if c.DeltaPkts != 3 || c.DeltaPktsUp != 2 {
		t.Errorf("want 3 packets, 2 sent: %+v", c)
	}
}

func TestConnKeepsItsRoundTripOnceClosed(t *testing.T) {
	s := testState()
	sock := procs.Sock{Pid: 7, Name: "curl", Proto: procs.TCP, LocalPort: 50000, RemoteAddr: anycast, RemotePort: 443}
	s.flow(procs.Event{Kind: procs.Flow, ID: 1, Sock: sock})
	// the round trip comes before the first packet does
	s.flow(procs.Event{Kind: procs.Stats, ID: 1, RTTms: 24})
	s.packets([]capture.Matched{packet(7, true, 100, time.Now().UnixMicro())})
	if b := s.batch(time.Now(), 0); len(b.Conns) != 1 || b.Conns[0].RTTms != 24 {
		t.Fatalf("a round trip from before the first packet should count: %+v", b.Conns)
	}
	if ep := s.endpoints[anycast]; ep.rttMs != 24 {
		t.Errorf("its endpoint should have it too, got %v", ep.rttMs)
	}
	s.flow(procs.Event{Kind: procs.Removed, ID: 1})
	if b := s.batch(time.Now(), 0); len(b.Conns) != 1 || b.Conns[0].RTTms != 24 || b.Conns[0].Open {
		t.Errorf("closing it shouldn't lose its round trip: %+v", b.Conns)
	}
}

func TestBurstIsThinned(t *testing.T) {
	s := testState()
	now := time.Now().UnixMicro()
	const n = 3*maxConnRecords + 5
	burst := make([]capture.Matched, n)
	for i := range burst {
		burst[i] = packet(7, false, 1500, now+int64(i))
	}
	s.packets(burst)
	b := s.batch(time.Now(), 0)
	c := b.Chunks[0]
	if c.N > maxConnRecords || c.Weight < 2 {
		t.Errorf("a burst should be thinned to at most %d records, got %d at weight %d", maxConnRecords, c.N, c.Weight)
	}
	// what's recorded still stands for what came in
	if got := int(c.N) * int(c.Weight); got < n-int(c.Weight) || got > n+int(c.Weight) {
		t.Errorf("%d records at weight %d stand for %d packets, want about %d", c.N, c.Weight, got, n)
	}
	if b.Conns[0].BytesDown != 1500*n {
		t.Errorf("bytes should be exact whatever's recorded, got %d", b.Conns[0].BytesDown)
	}
	// the next batch records everything again
	s.packets([]capture.Matched{packet(7, false, 1500, now+n)})
	if b := s.batch(time.Now(), 0); b.Chunks[0].Weight != 1 || b.Chunks[0].N != 1 {
		t.Errorf("thinning should only last the batch: %+v", b.Chunks[0])
	}
}

func TestTracesAreAskedForAgain(t *testing.T) {
	s := testState()
	p := enrich.RoutePrefix(anycast)
	// one that never came back is asked for again once it's been given up on
	s.tracing[p] = time.Now().Add(-traceGiveUp - time.Minute)
	s.maybeTrace(anycast)
	if time.Since(s.tracing[p]) > time.Minute {
		t.Error("a trace that never came back should be asked for again")
	}
	// a stale route is traced again while something's still talking along it, and
	// one nothing uses any more is forgotten
	delete(s.tracing, p)
	s.routes[p] = &route{r: enrich.Route{Prefix: p, Dst: anycast, At: time.Now().Add(-retraceAfter - time.Hour)}}
	unused := enrich.RoutePrefix(netip.MustParseAddr("9.9.9.9"))
	s.routes[unused] = &route{r: enrich.Route{Prefix: unused, At: time.Now().Add(-retraceAfter - time.Hour)}}
	s.packets([]capture.Matched{packet(7, true, 100, time.Now().UnixMicro())})
	s.batch(time.Now(), 0)
	if _, ok := s.tracing[p]; !ok {
		t.Error("an endpoint that's still talking should have its old route traced again")
	}
	if _, ok := s.routes[unused]; ok {
		t.Error("a stale route nothing uses should be forgotten")
	}
}
