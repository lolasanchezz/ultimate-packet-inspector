package capture

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/google/gopacket/layers"
	"github.com/google/gopacket/pcap"
)

// direction comes from the interface's mac address, which can change under us -
// macOS gives each wifi network its own private one - so it's read again this often
const macEvery = 5 * time.Second

// Source reads packets off one interface
type Source struct {
	Iface   string
	handle  *pcap.Handle
	dec     *Decoder
	nextMAC time.Time
	done    chan struct{} // closed when Run returns
}

func Open(iface string) (*Source, error) {
	inactive, err := pcap.NewInactiveHandle(iface)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", iface, err)
	}
	defer inactive.CleanUp()
	// enough for a whole segment, so tls hellos + dns answers can be read
	inactive.SetSnapLen(1600)
	// wifi on macOS can't do promiscuous mode, and only this machine's traffic matters
	inactive.SetPromisc(false)
	// hand over each packet as soon as it arrives - otherwise macOS holds them until
	// its buffer fills. the timeout is only so Run notices when it should stop
	inactive.SetImmediateMode(true)
	inactive.SetTimeout(250 * time.Millisecond)
	// room for a burst while the matcher catches up, instead of dropping
	inactive.SetBufferSize(16 << 20)

	handle, err := inactive.Activate()
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", iface, err)
	}
	if handle.LinkType() != layers.LinkTypeEthernet {
		handle.Close()
		return nil, fmt.Errorf("%s isn't an ethernet/wifi interface (link type %s)", iface, handle.LinkType())
	}

	s := &Source{Iface: iface, handle: handle, dec: NewDecoder(nil), done: make(chan struct{})}
	s.refreshMAC(time.Now())
	return s, nil
}

func (s *Source) refreshMAC(now time.Time) {
	if now.Before(s.nextMAC) {
		return
	}
	s.nextMAC = now.Add(macEvery)
	if i, err := net.InterfaceByName(s.Iface); err == nil && !bytes.Equal(i.HardwareAddr, s.dec.mac) {
		s.dec.mac = i.HardwareAddr
	}
}

// Run reads until ctx is done, handing each packet to out
func (s *Source) Run(ctx context.Context, out chan<- Packet) error {
	defer close(s.done)
	var p Packet
	for ctx.Err() == nil {
		data, ci, err := s.handle.ZeroCopyReadPacketData()
		if errors.Is(err, pcap.NextErrorTimeoutExpired) {
			s.refreshMAC(time.Now())
			continue
		}
		if err != nil {
			return fmt.Errorf("reading %s: %w", s.Iface, err)
		}
		s.refreshMAC(ci.Timestamp)
		if !s.dec.Decode(data, ci, &p) {
			continue
		}
		select {
		case out <- p:
		case <-ctx.Done():
		}
	}
	return nil
}

// Dropped is how many packets the kernel had to throw away because we were too slow
func (s *Source) Dropped() int {
	stats, err := s.handle.Stats()
	if err != nil {
		return 0
	}
	return stats.PacketsDropped + stats.PacketsIfDropped
}

// Close waits for Run to stop first (its context has to be done by now) - the
// packet it's on is still in libpcap's buffer, which closing frees
func (s *Source) Close() {
	select {
	case <-s.done:
	case <-time.After(time.Second): // Run never started
	}
	s.handle.Close()
}
