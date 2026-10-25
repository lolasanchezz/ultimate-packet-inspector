// Package capture reads packets off the wire and works out which process each
// one belongs to. it's the hot path, so the common case allocates nothing
package capture

import (
	"bytes"
	"encoding/binary"
	"net"
	"net/netip"
	"sync/atomic"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
)

type Dir uint8

const (
	In  Dir = iota // received by this machine
	Out            // sent from this machine
)

// ip protocol numbers
const (
	ICMP   uint8 = 1
	TCP    uint8 = 6
	UDP    uint8 = 17
	ICMPv6 uint8 = 58
)

// tcp flags, the way they sit in the header. CWR is left off so they fit in 7 bits
const (
	FIN uint8 = 1 << iota
	SYN
	RST
	PSH
	ACK
	URG
	ECE
)

// a name the traffic itself gives away - a dns answer
type Name struct {
	Addr netip.Addr
	Host string
}

// one packet's header - everything the agent keeps about it
type Packet struct {
	TimeUs    int64
	Size      uint32 // on the wire
	Src, Dst  netip.Addr
	SrcPort   uint16
	DstPort   uint16
	Proto     uint8 // ip protocol number, 0 if it isn't ip (arp etc)
	TTL       uint8 // ttl, or hop limit for ipv6
	Flags     uint8 // tcp flags
	Dir       Dir
	Broadcast bool   // to a broadcast/multicast address, so no one process owns it
	Plaintext bool   // readable text in the payload
	SNI       string // the server a tls ClientHello asked for
	Names     []Name // dns answers
}

// the other end of the packet
func (p *Packet) Remote() (netip.Addr, uint16) {
	if p.Dir == Out {
		return p.Dst, p.DstPort
	}
	return p.Src, p.SrcPort
}

// the port on this machine's end
func (p *Packet) LocalPort() uint16 {
	if p.Dir == Out {
		return p.SrcPort
	}
	return p.DstPort
}

// the echo id our own traceroute probes use, so they (and the routers answering
// them) can be dropped instead of showing up as traffic
var SelfICMPID atomic.Uint32

// Decoder turns frames into Packets. it reuses the same layers for every frame,
// so it isn't safe to share between goroutines
type Decoder struct {
	mac    net.HardwareAddr
	parser *gopacket.DecodingLayerParser
	eth    layers.Ethernet
	ip4    layers.IPv4
	ip6    layers.IPv6
	tcp    layers.TCP
	udp    layers.UDP
	dns    layers.DNS
	found  []gopacket.LayerType
	hellos hellos
}

func NewDecoder(mac net.HardwareAddr) *Decoder {
	d := &Decoder{mac: mac, found: make([]gopacket.LayerType, 0, 8), hellos: make(hellos)}
	d.parser = gopacket.NewDecodingLayerParser(layers.LayerTypeEthernet, &d.eth, &d.ip4, &d.ip6, &d.tcp, &d.udp)
	// anything past udp/tcp gets looked at by hand, so stopping there isn't an error
	d.parser.IgnoreUnsupported = true
	return d
}

// Decode fills p from a captured frame, and says whether to keep it. data is only
// borrowed - nothing in p points into it afterwards
func (d *Decoder) Decode(data []byte, ci gopacket.CaptureInfo, p *Packet) bool {
	*p = Packet{TimeUs: ci.Timestamp.UnixMicro(), Size: uint32(ci.Length)}
	// truncated frames still give us whatever layers made it, so the error is ignored
	_ = d.parser.DecodeLayers(data, &d.found)
	if len(d.found) == 0 {
		return false
	}

	var payload []byte
	for _, lt := range d.found {
		switch lt {
		case layers.LayerTypeEthernet:
			if bytes.Equal(d.eth.SrcMAC, d.mac) {
				p.Dir = Out
			}
			// the low bit of the first byte marks broadcast + multicast addresses
			p.Broadcast = len(d.eth.DstMAC) > 0 && d.eth.DstMAC[0]&1 == 1
		case layers.LayerTypeIPv4:
			p.Src, p.Dst = addr(d.ip4.SrcIP), addr(d.ip4.DstIP)
			p.TTL, p.Proto = d.ip4.TTL, uint8(d.ip4.Protocol)
			payload = d.ip4.Payload
		case layers.LayerTypeIPv6:
			p.Src, p.Dst = addr(d.ip6.SrcIP), addr(d.ip6.DstIP)
			p.TTL, p.Proto = d.ip6.HopLimit, uint8(d.ip6.NextHeader)
			payload = d.ip6.Payload
		case layers.LayerTypeTCP:
			p.SrcPort, p.DstPort = uint16(d.tcp.SrcPort), uint16(d.tcp.DstPort)
			p.Flags = tcpFlags(&d.tcp)
			payload = d.tcp.Payload
		case layers.LayerTypeUDP:
			p.SrcPort, p.DstPort = uint16(d.udp.SrcPort), uint16(d.udp.DstPort)
			payload = d.udp.Payload
		}
	}

	switch p.Proto {
	case ICMP, ICMPv6:
		return !d.selfICMP(p.Proto, payload)
	case TCP:
		if p.Dir == Out && len(payload) > 0 {
			p.SNI = d.hellos.sni(p, payload)
		}
	case UDP:
		if isDNSPort(p.SrcPort) || isDNSPort(p.DstPort) {
			p.Names = d.dnsNames(payload)
			return true
		}
	}
	if len(payload) > 0 && !quietPort(p.SrcPort) && !quietPort(p.DstPort) {
		p.Plaintext = looksPlaintext(payload)
	}
	return true
}

func addr(ip net.IP) netip.Addr {
	a, _ := netip.AddrFromSlice(ip)
	return a.Unmap()
}

func tcpFlags(t *layers.TCP) (f uint8) {
	for _, b := range [...]struct {
		set  bool
		flag uint8
	}{{t.FIN, FIN}, {t.SYN, SYN}, {t.RST, RST}, {t.PSH, PSH}, {t.ACK, ACK}, {t.URG, URG}, {t.ECE, ECE}} {
		if b.set {
			f |= b.flag
		}
	}
	return f
}

// whether an icmp message is one of our traceroute probes, or a router or the
// destination answering one. echoes carry the id right in them; time exceeded
// carries the start of the probe it's about
func (d *Decoder) selfICMP(proto uint8, b []byte) bool {
	id := SelfICMPID.Load()
	if id == 0 || len(b) < 8 {
		return false
	}
	echoID := func(b []byte) uint32 { return uint32(binary.BigEndian.Uint16(b[4:6])) }
	switch {
	case proto == ICMP && (b[0] == 8 || b[0] == 0): // echo request/reply
		return echoID(b) == id
	case proto == ICMP && b[0] == 11: // time exceeded
		inner := b[8:]
		if len(inner) < 20 {
			return false
		}
		ihl := int(inner[0]&0x0f) * 4
		return len(inner) >= ihl+8 && echoID(inner[ihl:]) == id
	case proto == ICMPv6 && (b[0] == 128 || b[0] == 129):
		return echoID(b) == id
	case proto == ICMPv6 && b[0] == 3:
		inner := b[8:]
		return len(inner) >= 48 && echoID(inner[40:]) == id
	}
	return false
}
