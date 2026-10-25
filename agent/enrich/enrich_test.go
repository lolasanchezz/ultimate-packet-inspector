package enrich

import (
	"context"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestClassify(t *testing.T) {
	for addr, want := range map[string]Kind{
		"8.8.8.8":         Public,
		"192.168.1.1":     LAN,
		"10.0.0.1":        LAN,
		"fe80::1":         LAN,
		"fd00::1":         LAN,
		"127.0.0.1":       Loopback,
		"::1":             Loopback,
		"100.100.100.100": CGNAT,
		"224.0.0.251":     Multicast,
		"ff02::fb":        Multicast,
		"255.255.255.255": Multicast,
		"0.0.0.0":         Unknown,
		"::ffff:1.1.1.1":  Public,
	} {
		if got := Classify(netip.MustParseAddr(addr)); got != want {
			t.Errorf("%s: got %s, want %s", addr, got, want)
		}
	}
}

var (
	nyc    = LatLon{40.71, -74.01}
	london = LatLon{51.51, -0.13}
	sydney = LatLon{-33.87, 151.21}
)

func TestDistance(t *testing.T) {
	if d := DistanceKm(nyc, london); d < 5550 || d > 5600 {
		t.Errorf("new york to london = %.0fkm, want ~5570", d)
	}
}

func TestPhysics(t *testing.T) {
	// 2ms can't reach london from new york - it's an anycast address answering locally
	if Possible(nyc, london, 2) {
		t.Error("2ms to london from new york should be impossible")
	}
	// 75ms easily can
	if !Possible(nyc, london, 75) {
		t.Error("75ms to london from new york should be fine")
	}
	// no rtt means nothing to check against
	if !Possible(nyc, sydney, 0) {
		t.Error("no rtt shouldn't rule anything out")
	}
}

func TestToward(t *testing.T) {
	mid := Toward(nyc, london, DistanceKm(nyc, london)/2)
	if d1, d2 := DistanceKm(nyc, mid), DistanceKm(mid, london); d1-d2 > 1 || d2-d1 > 1 {
		t.Errorf("halfway point is %.0f / %.0f km from each end", d1, d2)
	}
}

func TestOwnerOf(t *testing.T) {
	o, ok := OwnerOf("stats.g.doubleclick.net")
	if !ok || o.Name != "Google" || !o.Tracker || !slices.Contains(o.Categories, "Advertising") {
		t.Errorf("doubleclick: %+v, %v", o, ok)
	}
	if o, ok := OwnerOf("www.youtube.com."); !ok || o.Name != "Google" {
		t.Errorf("youtube: %+v, %v", o, ok)
	}
	if o, ok := OwnerOf("www.icloud.com"); !ok || o.Name != "Apple" || o.Tracker {
		t.Errorf("icloud: %+v, %v", o, ok)
	}
	if _, ok := OwnerOf("some-random-site-nobody-owns.example"); ok {
		t.Error("unknown domains shouldn't have an owner")
	}
	if _, ok := OwnerOf(""); ok {
		t.Error("no host, no owner")
	}
}

func TestHintFromName(t *testing.T) {
	for ptr, city := range map[string]string{
		"ae-1.r21.sea01.us.bb.gin.ntt.net":           "Seattle",
		"ae-0.r20.lsanca07.us.bb.gin.ntt.net":        "Los Angeles",
		"be3271.ccr41.lon13.atlas.cogentco.com":      "London",
		"ae-2-3602.ear2.frankfurt1.level3.net":       "Frankfurt",
		"et-0-0-1.cr1.syd1.au.example-carrier.net":   "Sydney (Mascot)",
		"xe-1-2-0.mpr1.fra4.de.zip.zayo.com":         "Frankfurt am Main",
		"static-12-34-56-78.res.example-isp-net.com": "",
		// real ones that went wrong: santa clara read as santiago, a company called
		// phoenixNAP read as naples, codes the airport table didn't have
		"be12.cr6-scl.bb.as11404.net":                "Santa Clara",
		"PHOENIX-NAP.edge2.Washington111.Level3.net": "Washington",
		"be3.core1.pao1.he.net":                      "Palo Alto",
		"100ge0-0-0-17.core2.fmt2.he.net":            "Fremont",
		"eth.13.1.iedge2.ash0.phoenixnap.com":        "Ashburn",
		"eqix-dc2.phoenixnap.com":                    "",
		"instagram-p3-shv-01-sea5.fbcdn.net":         "Seattle",
		"po101.asw01.sea1.tfbnw.net":                 "Seattle",
		"cr1-200p-a-be100.bb.spectrumnet.us":         "",
	} {
		p, code, ok := hintFromName(ptr)
		if city == "" {
			if ok {
				t.Errorf("%s: shouldn't place it, got %s from %q", ptr, p.City, code)
			}
			continue
		}
		if !ok || p.City != city {
			t.Errorf("%s: got %q (from %q), want %q", ptr, p.City, code, city)
		}
	}
}

// against the real databases, when they've been fetched
func TestGeo(t *testing.T) {
	dir, _ := os.UserConfigDir()
	g, err := OpenGeo(filepath.Join(dir, "upi"))
	if err != nil {
		t.Skip("geo databases not fetched - run scripts/fetch-geo.sh")
	}
	defer g.Close()
	if n, ok := g.Network(netip.MustParseAddr("8.8.8.8")); !ok || n.ASN != 15169 {
		t.Errorf("8.8.8.8: %+v", n)
	}
	if p, ok := g.Place(netip.MustParseAddr("8.8.8.8")); !ok || p.CountryCode == "" {
		t.Errorf("8.8.8.8 place: %+v", p)
	}
	if _, ok := g.Place(netip.MustParseAddr("192.168.1.1")); ok {
		t.Error("private addresses have no place")
	}
}

func TestRTTBounds(t *testing.T) {
	a := func(s string) netip.Addr { return netip.MustParseAddr(s) }
	// a slow early answer (wifi) is held to the quicker ones after it
	hops := []Hop{
		{TTL: 1, Addr: a("10.0.0.1"), RTTms: 296},
		{TTL: 2}, // no answer
		{TTL: 3, Addr: a("1.0.0.3"), RTTms: 213},
		{TTL: 4, Addr: a("1.0.0.4"), RTTms: 115},
		{TTL: 5, Addr: a("1.0.0.5"), RTTms: 130},
	}
	if got, want := rttBounds(hops), []float64{115, 115, 115, 115, 130}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

// a probe's seq has 5 bits for its ttl and 3 for its round
func TestProbesFitTheirSeq(t *testing.T) {
	if maxHops > 31 || probesPerHop > 8 {
		t.Errorf("maxHops %d, probesPerHop %d don't fit in a probe's seq", maxHops, probesPerHop)
	}
}

// a real traceroute - only with UPI_TRACE=1, since it needs a network
func TestTraceLive(t *testing.T) {
	if os.Getenv("UPI_TRACE") == "" {
		t.Skip("set UPI_TRACE=1 to trace 1.1.1.1 for real")
	}
	hops, err := NewTracer().Trace(context.Background(), netip.MustParseAddr("1.1.1.1"))
	if err != nil || len(hops) == 0 {
		t.Fatalf("%v, %d hops", err, len(hops))
	}
	for _, h := range hops {
		t.Logf("%2d %-16v %6.1fms", h.TTL, h.Addr, h.RTTms)
	}
	if last := hops[len(hops)-1]; last.Addr != netip.MustParseAddr("1.1.1.1") {
		t.Errorf("didn't reach 1.1.1.1: last hop %v", last.Addr)
	}
}
