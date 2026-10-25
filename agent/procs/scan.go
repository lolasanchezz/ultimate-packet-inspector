package procs

/*
#cgo CFLAGS: -I${SRCDIR}/c_files
#include "ex_ppi.c"
*/
import "C"
import "unsafe"

// Scan lists every socket on the machine through libproc - the lsof way. it's
// slower than flow events and can't see QUIC or root's sockets, so it's only
// the fallback for when Start fails
func Scan() []Sock {
	var count C.int
	C.socketCount(&count)
	if count == 0 {
		return nil
	}

	// sockets can open between counting and filling, so leave some room. the C side
	// never writes past capacity and says how many it actually filled
	capacity := count + count/4 + 16
	buf := make([]C.struct_socketInfo, capacity)
	C.goSocketStructs(unsafe.Pointer(&buf[0]), capacity, &count)

	socks := make([]Sock, 0, count)
	for _, s := range buf[:count] {
		if s.local != 0 {
			continue // loopback never reaches the capture interface
		}
		if s.sourcePort == 0 && s.destPort == 0 {
			continue // not an internet socket (unix, kernel control), or not bound yet
		}
		proto := UDP
		if s.socket_type == C.TCP {
			proto = TCP
		}
		sock := Sock{
			Pid:        int32(s.pid),
			Name:       C.GoString(&s.processName[0]),
			Proto:      proto,
			LocalPort:  uint16(s.sourcePort),
			RemotePort: uint16(s.destPort),
			Listening:  s.listening != 0 && proto == TCP,
		}
		if sock.RemotePort != 0 {
			sock.RemoteAddr = parseAddr(C.GoString(&s.destIPAddr[0]))
		}
		socks = append(socks, sock)
	}
	return socks
}
