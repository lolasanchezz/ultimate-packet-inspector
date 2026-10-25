package enrich

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net"
	"net/netip"
	"sync/atomic"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"

	"upi/capture"
)

const (
	maxHops = 30 // fits the 5 bits a probe's seq has for it
	// every ttl's probed this many times, and its fastest answer kept - wifi makes any
	// one round trip slower than the distance alone would, sometimes by hundreds of ms
	probesPerHop = 5 // up to 8 - 3 bits of the seq
	// between probes. a tight burst queues up on wifi and makes the early hops'
	// round trips look far longer than they are
	probeGap    = 20 * time.Millisecond
	traceWindow = 2 * time.Second // how long answers are waited for after the last probe
)

// one router (or the destination) on the way to somewhere
type Hop struct {
	TTL   int        `json:"ttl"`
	Addr  netip.Addr `json:"addr"` // unset when nothing answered at this ttl
	RTTms float64    `json:"rttMs"`
}

// Tracer does traceroutes over macOS's unprivileged icmp sockets - no root
// needed. every probe carries one echo id, so capture can drop them (and the
// answers) instead of showing them as traffic
type Tracer struct {
	id    int
	trace atomic.Uint32 // which trace a probe belongs to lives in its seq's high bits
}

func NewTracer() *Tracer {
	t := &Tracer{id: 1 + rand.IntN(0xfffe)}
	capture.SelfICMPID.Store(uint32(t.id))
	return t
}

// Trace sends a probe at every ttl, probesPerHop rounds over, and collects who
// answers - so a whole trace takes a few seconds however long the path is
func (t *Tracer) Trace(ctx context.Context, dst netip.Addr) ([]Hop, error) {
	dst = dst.Unmap()
	network, echo, proto := "udp4", icmp.Type(ipv4.ICMPTypeEcho), 1
	if dst.Is6() {
		network, echo, proto = "udp6", ipv6.ICMPTypeEchoRequest, 58
	}
	c, err := icmp.ListenPacket(network, "")
	if err != nil {
		return nil, fmt.Errorf("icmp socket: %w", err)
	}
	defer c.Close()
	setTTL := func(ttl int) error {
		if dst.Is6() {
			return c.IPv6PacketConn().SetHopLimit(ttl)
		}
		return c.IPv4PacketConn().SetTTL(ttl)
	}

	// seq = trace number << 8 | round << 5 | ttl, so concurrent traces can't take
	// each other's answers, and each answer's matched to the probe it's for (ttls fit
	// in 5 bits, rounds in 3)
	traceNum := int(t.trace.Add(1)%256) << 8
	// when each probe went out, in unix nanos - written by the sender, read here
	var sent [probesPerHop][maxHops + 1]atomic.Int64
	var reached atomic.Int32 // the destination's ttl, once it's answered - later rounds stop there
	reached.Store(maxHops + 1)
	to := &net.UDPAddr{IP: dst.AsSlice()}
	go func() {
		for round := range probesPerHop {
			for ttl := 1; ttl <= maxHops && ttl <= int(reached.Load()) && ctx.Err() == nil; ttl++ {
				msg := icmp.Message{Type: echo, Body: &icmp.Echo{ID: t.id, Seq: traceNum | round<<5 | ttl, Data: []byte("upi traceroute")}}
				b, _ := msg.Marshal(nil)
				if setTTL(ttl) == nil {
					sent[round][ttl].Store(time.Now().UnixNano())
					c.WriteTo(b, to)
				}
				time.Sleep(probeGap)
			}
		}
	}()

	hops := make([]Hop, maxHops+1)
	var answered [probesPerHop][maxHops + 1]bool
	deadline := time.Now().Add(probesPerHop*maxHops*probeGap + traceWindow)
	buf := make([]byte, 1500)
	for ctx.Err() == nil {
		c.SetReadDeadline(deadline)
		n, peer, err := c.ReadFrom(buf)
		if err != nil {
			break // the deadline - everyone who was going to answer has
		}
		at := time.Now()
		msg, err := icmp.ParseMessage(proto, buf[:n])
		if err != nil {
			continue
		}
		seq, isEnd := t.seqOf(msg, dst)
		round, ttl := seq>>5&7, seq&0x1f
		if seq&^0xff != traceNum || round >= probesPerHop || ttl < 1 || ttl > maxHops || answered[round][ttl] || sent[round][ttl].Load() == 0 {
			continue
		}
		from, ok := netip.AddrFromSlice(peer.(*net.UDPAddr).IP)
		if !ok {
			continue
		}
		answered[round][ttl] = true
		rtt := float64(at.UnixNano()-sent[round][ttl].Load()) / 1e6
		switch h := &hops[ttl]; {
		case !h.Addr.IsValid():
			*h = Hop{TTL: ttl, Addr: from.Unmap(), RTTms: rtt}
		case h.Addr == from.Unmap():
			h.RTTms = min(h.RTTms, rtt)
		default:
			// a different router at the same ttl (the path's load balanced) - its
			// time isn't this one's, so it's left out
		}
		if isEnd && ttl < int(reached.Load()) {
			reached.Store(int32(ttl))
		}
		if r := int(reached.Load()); r <= maxHops && allProbed(answered[:], r) {
			break
		}
	}
	end := int(reached.Load())

	// past the destination, every probe gets an echo reply from it too
	last := min(end, maxHops)
	for last > 0 && !hops[last].Addr.IsValid() {
		last--
	}
	out := hops[1 : last+1]
	for i := range out {
		out[i].TTL = i + 1
	}
	return out, ctx.Err()
}

// whether every round's probe to every ttl up to the destination has an answer
func allProbed(answered [][maxHops + 1]bool, upTo int) bool {
	for _, round := range answered {
		for ttl := 1; ttl <= upTo; ttl++ {
			if !round[ttl] {
				return false
			}
		}
	}
	return true
}

// the seq of the probe a message is answering, and whether it came from the
// destination itself. 0 for anything that isn't about one of ours
func (t *Tracer) seqOf(msg *icmp.Message, dst netip.Addr) (seq int, isEnd bool) {
	switch body := msg.Body.(type) {
	case *icmp.Echo: // the destination answering
		if body.ID == t.id {
			return body.Seq, true
		}
	case *icmp.TimeExceeded: // a router on the way - it sends back the start of our probe
		inner := body.Data
		hdr := 40 // ipv6
		if dst.Is4() {
			if len(inner) < 20 {
				return 0, false
			}
			hdr = int(inner[0]&0x0f) * 4
		}
		if len(inner) < hdr+8 {
			return 0, false
		}
		probe := inner[hdr:]
		if int(probe[4])<<8|int(probe[5]) != t.id {
			return 0, false
		}
		return int(probe[6])<<8 | int(probe[7]), false
	}
	return 0, false
}
