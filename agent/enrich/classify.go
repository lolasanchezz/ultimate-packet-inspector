// Package enrich finds out everything about the other end of a connection that
// the packets don't say: where it is, who owns it, how the traffic gets there.
// none of it is on the hot path - it runs once per new address
package enrich

import "net/netip"

// what kind of address something is. only Public ones get looked up + drawn
type Kind uint8

const (
	Public    Kind = iota
	LAN            // private ranges, link-local, unique local
	Loopback       //
	CGNAT          // 100.64/10 - carrier nat, or tailscale
	Multicast      // and broadcast
	Unknown        // unspecified, invalid
)

func (k Kind) String() string {
	return [...]string{"public", "lan", "loopback", "cgnat", "multicast", "unknown"}[k]
}

var (
	cgnat     = netip.MustParsePrefix("100.64.0.0/10")
	broadcast = netip.MustParseAddr("255.255.255.255")
)

func Classify(a netip.Addr) Kind {
	a = a.Unmap()
	switch {
	case !a.IsValid() || a.IsUnspecified():
		return Unknown
	case a.IsLoopback():
		return Loopback
	case a.IsMulticast() || a == broadcast:
		return Multicast
	case a.IsPrivate() || a.IsLinkLocalUnicast():
		return LAN
	case cgnat.Contains(a):
		return CGNAT
	}
	return Public
}

// the block an address is traced as part of - addresses next to each other
// almost always take the same path, so one trace covers them all
func RoutePrefix(a netip.Addr) netip.Prefix {
	bits := 24
	if a.Is6() {
		bits = 48
	}
	p, _ := a.Prefix(bits)
	return p
}
