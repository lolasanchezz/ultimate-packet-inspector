package enrich

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"time"
)

// Namer does reverse dns (PTR) lookups, gently. it uses go's own resolver, so
// the queries come from this process (and get filtered out) instead of from
// mDNSResponder, where they'd show up as someone else's traffic
type Namer struct {
	resolver *net.Resolver
	limit    *time.Ticker
}

const (
	lookupsPerSecond = 5
	lookupTimeout    = 2 * time.Second
)

func NewNamer() *Namer {
	return &Namer{
		resolver: &net.Resolver{PreferGo: true},
		limit:    time.NewTicker(time.Second / lookupsPerSecond),
	}
}

// Lookup is the PTR name for a, or "" if there isn't one
func (n *Namer) Lookup(ctx context.Context, a netip.Addr) string {
	select {
	case <-n.limit.C:
	case <-ctx.Done():
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	names, err := n.resolver.LookupAddr(ctx, a.String())
	if err != nil || len(names) == 0 {
		return ""
	}
	return strings.TrimSuffix(names[0], ".")
}
