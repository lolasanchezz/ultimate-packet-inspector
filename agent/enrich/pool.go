package enrich

import (
	"context"
	"net"
	"net/netip"
	"sync/atomic"
	"time"
)

const (
	lookupWorkers = 4
	traceWorkers  = 2
	queueLen      = 1024
)

// Endpoint is what the enricher found out about one address
type Endpoint struct {
	Addr    netip.Addr
	Kind    Kind
	Place   Place
	Located bool
	Network Network
	PTR     string
}

// Route is one traced path - shared by every address in Prefix
type Route struct {
	Prefix netip.Prefix
	Dst    netip.Addr // the address that was actually traced
	Hops   []RouteHop
	At     time.Time
}

type RouteHop struct {
	Hop
	PTR      string
	Network  Network
	Place    Place
	Located  bool
	From     string // where the place came from: "geoip", or the code in its name
	Possible bool   // whether the place fits the hop's rtt
}

// Enricher runs lookups and traces on worker pools, so nothing slow ever waits
// on the packet path. results come out of Out as Endpoints and Routes
type Enricher struct {
	geo     *Geo
	namer   *Namer
	tracer  *Tracer
	home    atomic.Pointer[LatLon]
	lookups chan netip.Addr
	traces  chan netip.Addr
	Out     chan any
}

func NewEnricher(geo *Geo) *Enricher {
	return &Enricher{
		geo:     geo,
		namer:   NewNamer(),
		tracer:  NewTracer(),
		lookups: make(chan netip.Addr, queueLen),
		traces:  make(chan netip.Addr, queueLen),
		Out:     make(chan any, queueLen),
	}
}

// SetHome is where traces are measured from, for the physics checks
func (e *Enricher) SetHome(h LatLon) { e.home.Store(&h) }

func (e *Enricher) Start(ctx context.Context) {
	for range lookupWorkers {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case a := <-e.lookups:
					e.send(ctx, e.lookup(ctx, a))
				}
			}
		}()
	}
	for range traceWorkers {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case a := <-e.traces:
					if r, ok := e.trace(ctx, a); ok {
						e.send(ctx, r)
					}
				}
			}
		}()
	}
}

func (e *Enricher) send(ctx context.Context, v any) {
	select {
	case e.Out <- v:
	case <-ctx.Done():
	}
}

// Lookup queues an address to be looked up. false if the queue's full - try again later
func (e *Enricher) Lookup(a netip.Addr) bool {
	select {
	case e.lookups <- a:
		return true
	default:
		return false
	}
}

// Trace queues a traceroute to an address. false if the queue's full
func (e *Enricher) Trace(a netip.Addr) bool {
	select {
	case e.traces <- a:
		return true
	default:
		return false
	}
}

func (e *Enricher) lookup(ctx context.Context, a netip.Addr) Endpoint {
	ep := Endpoint{Addr: a, Kind: Classify(a)}
	if ep.Kind != Public {
		return ep
	}
	ep.Place, ep.Located = e.geo.Place(a)
	ep.Network, _ = e.geo.Network(a)
	ep.PTR = e.namer.Lookup(ctx, a)
	return ep
}

func (e *Enricher) trace(ctx context.Context, dst netip.Addr) (Route, bool) {
	hops, err := e.tracer.Trace(ctx, dst)
	if err != nil || len(hops) == 0 {
		return Route{}, false
	}
	home := e.home.Load()
	r := Route{Prefix: RoutePrefix(dst), Dst: dst, At: time.Now()}
	bounds := rttBounds(hops)
	for i, h := range hops {
		rh := RouteHop{Hop: h}
		if h.Addr.IsValid() {
			rh.Network, _ = e.geo.Network(h.Addr)
			if Classify(h.Addr) == Public {
				rh.PTR = e.namer.Lookup(ctx, h.Addr)
				e.locateHop(&rh, home, bounds[i])
			}
		}
		r.Hops = append(r.Hops, rh)
	}
	return r, true
}

// the round trip that bounds how far away each router can be: its own, or any
// later router's if that's quicker. a router's on the way to every router after
// it, so it can't be further from home than their answers allow either - which
// keeps one slow answer (wifi, a busy router) from letting it be anywhere
func rttBounds(hops []Hop) []float64 {
	out := make([]float64, len(hops))
	best := 0.0
	for i := len(hops) - 1; i >= 0; i-- {
		if h := hops[i]; h.Addr.IsValid() && h.RTTms > 0 && (best == 0 || h.RTTms < best) {
			best = h.RTTms
		}
		out[i] = best
	}
	return out
}

// a router's name beats geo-ip (which usually only knows the carrier's head
// office), as long as the name's place fits the round trip time. a place that
// doesn't fit either way is left out - the website draws through the gap
func (e *Enricher) locateHop(rh *RouteHop, home *LatLon, rttMs float64) {
	fits := func(p LatLon) bool { return home == nil || Possible(*home, p, rttMs) }
	if hint, code, ok := hintFromName(rh.PTR); ok && fits(hint.LatLon) {
		rh.Place = Place{LatLon: hint.LatLon, City: hint.City, CountryCode: hint.CountryCode}
		rh.Located, rh.From, rh.Possible = true, code, true
		return
	}
	if p, ok := e.geo.Place(rh.Addr); ok {
		rh.Place, rh.From = p, "geoip"
		rh.Possible = fits(p.LatLon)
		rh.Located = rh.Possible
	}
}

// PublicIP asks OpenDNS which address our queries come from - one dns query, no
// http, and it comes from this process so it's filtered out like the rest
func PublicIP(ctx context.Context) (netip.Addr, error) {
	r := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "udp", "208.67.222.222:53") // resolver1.opendns.com
	}}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := r.LookupNetIP(ctx, "ip4", "myip.opendns.com")
	if err != nil {
		return netip.Addr{}, err
	}
	return addrs[0].Unmap(), nil
}
