// Package procs finds out which process owns which connection. on macOS that's
// NetworkStatistics flow events (nstat.c), with a libproc socket scan
// (ex_ppi.c) for when those aren't available
package procs

import "net/netip"

// ip protocol numbers, so they line up with what's on the wire
type Proto uint8

const (
	TCP Proto = 6
	UDP Proto = 17
)

func (p Proto) String() string {
	switch p {
	case TCP:
		return "tcp"
	case UDP:
		return "udp"
	}
	return "other"
}

// one socket, from either source
type Sock struct {
	Pid        int32
	Name       string
	Proto      Proto
	LocalAddr  netip.Addr // unset from the socket scan
	LocalPort  uint16
	RemoteAddr netip.Addr // unset when it isn't connected to anything
	RemotePort uint16
	Listening  bool
}

// connected sockets have a remote end - listeners and unconnected udp don't
func (s Sock) Connected() bool { return s.RemotePort != 0 }

// the kernel's text for an address, or unset if there isn't a real one
func parseAddr(s string) netip.Addr {
	a, err := netip.ParseAddr(s)
	if err != nil || a.IsUnspecified() {
		return netip.Addr{}
	}
	return a.Unmap()
}
