package procs

/*
#cgo CFLAGS: -I${SRCDIR}/c_files -fblocks
#cgo LDFLAGS: -framework CoreFoundation
#include "nstat.c"
*/
import "C"
import "fmt"

// flows from NetworkStatistics - see c_files/nstat.c. unlike the socket scan they
// see network.framework flows (QUIC) and root's processes, without root

type EventKind int

const (
	Flow    EventKind = iota + 1 // a flow showed up or changed
	Removed                      // a flow went away - only ID is set
	Stats                        // a fresh round trip time - only ID + RTTms are set
)

type Event struct {
	Kind  EventKind
	ID    uint64
	Sock  Sock
	RTTms float64
}

// Start loads the framework and starts watching every tcp/udp flow. only the
// first call does anything
func Start() error {
	var errBuf [256]C.char
	if C.nstat_start(&errBuf[0], C.int(len(errBuf))) != 0 {
		return fmt.Errorf("network statistics: %s", C.GoString(&errBuf[0]))
	}
	return nil
}

// Next blocks until the next flow event
func Next() Event {
	var ev C.struct_nstat_event
	C.nstat_next(&ev)

	switch ev.kind {
	case C.NSTAT_STATS:
		return Event{Kind: Stats, ID: uint64(ev.id), RTTms: float64(ev.rttMs)}
	case C.NSTAT_REMOVED:
		return Event{Kind: Removed, ID: uint64(ev.id)}
	}

	proto := UDP
	if ev.proto == C.NSTAT_TCP {
		proto = TCP
	}
	sock := Sock{
		Pid:        int32(ev.pid),
		Name:       C.GoString(&ev.processName[0]),
		Proto:      proto,
		LocalAddr:  parseAddr(C.GoString(&ev.localAddr[0])),
		LocalPort:  uint16(ev.localPort),
		RemotePort: uint16(ev.remotePort),
		Listening:  ev.listening != 0,
	}
	if sock.RemotePort != 0 {
		sock.RemoteAddr = parseAddr(C.GoString(&ev.remoteAddr[0]))
	}
	return Event{Kind: Flow, ID: uint64(ev.id), Sock: sock}
}
