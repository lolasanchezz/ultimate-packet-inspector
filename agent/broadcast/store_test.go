package broadcast

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"upi/wire"
)

func fixture(t *testing.T) *wire.Batch {
	t.Helper()
	// written by the agent's TestBatchFixture
	data, err := os.ReadFile("../../testdata/batch.json")
	if err != nil {
		t.Fatal(err)
	}
	var b wire.Batch
	if err := json.Unmarshal(data, &b); err != nil {
		t.Fatal(err)
	}
	return &b
}

func TestIngestsExactlyWhatTheAgentSends(t *testing.T) {
	b := fixture(t)
	s := NewStore("m", "en0")
	got := s.Ingest(b, time.UnixMicro(b.TimeUs))
	if len(got.Conns) != 1 || got.Conns[0].Process != "curl" || got.Conns[0].RemoteIP != "1.1.1.1" || got.Conns[0].BytesUp+got.Conns[0].BytesDown != 1620 {
		t.Fatalf("conns: %+v", got.Conns)
	}
	if len(got.Endpoints) != 1 || got.Endpoints[0].Host != "one.one.one.one" || got.Endpoints[0].Possible {
		t.Fatalf("endpoints: %+v", got.Endpoints) // sydney, answering in 4ms - impossible
	}
	if lat := got.Endpoints[0].DrawnLat; lat < 37.3 || lat > 37.4 {
		t.Errorf("drawn at %v, want the san jose hop", lat)
	}
	var hops []wire.Hop
	if len(got.Routes) != 1 || json.Unmarshal([]byte(got.Routes[0].Hops), &hops) != nil || len(hops) != 2 {
		t.Fatalf("routes: %+v", got.Routes)
	}
	if len(got.Chunks) != 1 || got.Chunks[0].N != 2 {
		t.Fatalf("chunks: %+v", got.Chunks)
	}
	if len(got.Traffic) != 1 || got.Traffic[0].Pkts != 2 || len(got.Rollups) != 1 {
		t.Fatalf("traffic %+v, rollups %+v", got.Traffic, got.Rollups)
	}
	if got.Machine.HomeLat != 37.77 || !got.Machine.Nstat {
		t.Errorf("machine: %+v", got.Machine)
	}
	// and an app connecting after has all of it
	all := s.All()
	if len(all.Conns) != 1 || len(all.Endpoints) != 1 || len(all.Routes) != 1 || len(all.Chunks) != 1 {
		t.Errorf("all: %+v", all)
	}
}

func TestRollsUpByTheMinute(t *testing.T) {
	b := fixture(t)
	s := NewStore("m", "en0")
	now := time.UnixMicro(b.TimeUs)
	s.Ingest(b, now)
	b.TimeUs += 2 * second
	b.Endpoints, b.Chunks = nil, nil // only sent once
	got := s.Ingest(b, now.Add(2*time.Second))
	if len(got.Rollups) != 1 || got.Rollups[0].BytesDown != 3000 || got.Traffic[0].Pkts != 4 {
		t.Errorf("rollups %+v, traffic %+v", got.Rollups, got.Traffic)
	}
	// the endpoint's only resent when something talking to it moves its lastUs on
	if len(got.Endpoints) != 0 {
		t.Errorf("endpoint resent though its lastUs didn't move: %+v", got.Endpoints)
	}
}

func TestPrunes(t *testing.T) {
	b := fixture(t)
	s := NewStore("m", "en0")
	now := time.UnixMicro(b.TimeUs)
	s.Ingest(b, now)

	empty := &wire.Batch{TimeUs: b.TimeUs + minute}
	s.Ingest(empty, now.Add(time.Minute))
	if all := s.All(); len(all.Chunks) != 0 || len(all.Conns) != 1 {
		t.Errorf("after a minute: %d chunks (live packets go after 30s), %d conns", len(all.Chunks), len(all.Conns))
	}
	empty.TimeUs = b.TimeUs + HistoryFor + minute
	s.Ingest(empty, now.Add(time.Duration(HistoryFor+minute)*time.Microsecond))
	all := s.All()
	if len(all.Conns)+len(all.Endpoints)+len(all.Rollups)+len(all.Traffic) != 0 {
		t.Errorf("after a day: %+v", all)
	}
	if len(all.Routes) != 1 {
		t.Error("routes stay a little longer - one traced before the window still applies")
	}
}

func TestServerStreams(t *testing.T) {
	b := fixture(t)
	srv := NewServer(NewStore("m", "en0"))
	srv.Publish(b)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	go srv.Serve(ctx, addr)
	var res *http.Response
	for i := 0; i < 50; i++ {
		req, _ := http.NewRequest("GET", "http://"+addr+"/events", nil)
		req.Header.Set("Origin", AppOrigin)
		var err error
		if res, err = http.DefaultClient.Do(req); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if res == nil || res.StatusCode != 200 || res.Header.Get("Access-Control-Allow-Origin") != AppOrigin {
		t.Fatalf("connect: %+v", res)
	}
	defer res.Body.Close()
	r := bufio.NewReader(res.Body)
	next := func() (string, Rows) {
		var name string
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			if after, ok := strings.CutPrefix(line, "event: "); ok {
				name = strings.TrimSpace(after)
			} else if after, ok := strings.CutPrefix(line, "data: "); ok {
				var rows Rows
				if err := json.Unmarshal([]byte(after), &rows); err != nil {
					t.Fatal(err)
				}
				return name, rows
			}
		}
	}
	if name, rows := next(); name != "snapshot" || len(rows.Conns) != 1 {
		t.Fatalf("first: %s %+v", name, rows)
	}
	b.TimeUs += 2 * second
	srv.Publish(b)
	if name, rows := next(); name != "update" || rows.Rollups[0].BytesDown != 3000 {
		t.Fatalf("then: %s %+v", name, rows)
	}
}

func TestOnlyThisMachinesApps(t *testing.T) {
	for origin, ok := range map[string]bool{
		AppOrigin:                       true,
		"http://localhost:5173":         true,
		"http://127.0.0.1:5173":         true,
		"https://evil.example":          false,
		"null":                          false,
		"http://localhost.evil.example": false,
	} {
		if allowedOrigin(origin) != ok {
			t.Errorf("origin %q: allowed = %v", origin, !ok)
		}
	}
	for host, ok := range map[string]bool{"127.0.0.1:7323": true, "localhost:7323": true, "[::1]:7323": true, "rebound.example:7323": false} {
		if loopbackHost(host) != ok {
			t.Errorf("host %q: allowed = %v", host, !ok)
		}
	}
	if err := NewServer(NewStore("m", "en0")).Serve(context.Background(), "0.0.0.0:0"); err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Errorf("listening on every interface: %v", err)
	}
}
