package capture

import (
	"crypto/tls"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"

	"upi/procs"
)

var (
	ourMAC   = net.HardwareAddr{0x02, 0, 0, 0, 0, 1}
	theirMAC = net.HardwareAddr{0x02, 0, 0, 0, 0, 2}
	ourIP    = netip.MustParseAddr("192.168.1.20")
	theirIP  = netip.MustParseAddr("151.101.0.81")
)

// a frame from us (out) or to us (in), with a tcp or udp header and payload
func frame(t testing.TB, out bool, transport gopacket.SerializableLayer, payload []byte) []byte {
	t.Helper()
	eth := &layers.Ethernet{SrcMAC: theirMAC, DstMAC: ourMAC, EthernetType: layers.EthernetTypeIPv4}
	ip := &layers.IPv4{Version: 4, TTL: 57, SrcIP: theirIP.AsSlice(), DstIP: ourIP.AsSlice()}
	if out {
		eth.SrcMAC, eth.DstMAC = ourMAC, theirMAC
		ip.TTL, ip.SrcIP, ip.DstIP = 64, ourIP.AsSlice(), theirIP.AsSlice()
	}
	switch tr := transport.(type) {
	case *layers.TCP:
		ip.Protocol = layers.IPProtocolTCP
		tr.SetNetworkLayerForChecksum(ip)
	case *layers.UDP:
		ip.Protocol = layers.IPProtocolUDP
		tr.SetNetworkLayerForChecksum(ip)
	}
	buf := gopacket.NewSerializeBuffer()
	opts := gopacket.SerializeOptions{FixLengths: true, ComputeChecksums: true}
	if err := gopacket.SerializeLayers(buf, opts, eth, ip, transport, gopacket.Payload(payload)); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func decode(d *Decoder, data []byte) (Packet, bool) {
	var p Packet
	ok := d.Decode(data, gopacket.CaptureInfo{Timestamp: time.UnixMicro(1_700_000_000_000_000), Length: len(data)}, &p)
	return p, ok
}

func TestDecodeTCP(t *testing.T) {
	d := NewDecoder(ourMAC)
	data := frame(t, true, &layers.TCP{SrcPort: 51000, DstPort: 80, SYN: true, ACK: true}, []byte("GET /index.html HTTP/1.1\r\nHost: example.com\r\n\r\n"))
	p, ok := decode(d, data)
	if !ok {
		t.Fatal("dropped")
	}
	if p.Dir != Out || p.Src != ourIP || p.Dst != theirIP || p.SrcPort != 51000 || p.DstPort != 80 {
		t.Errorf("wrong addresses: %+v", p)
	}
	if p.Proto != TCP || p.TTL != 64 || p.Flags != SYN|ACK || int(p.Size) != len(data) {
		t.Errorf("wrong header fields: %+v", p)
	}
	if !p.Plaintext {
		t.Error("an http request should count as plaintext")
	}
	if remote, port := p.Remote(); remote != theirIP || port != 80 || p.LocalPort() != 51000 {
		t.Errorf("remote end = %v:%d, local port %d", remote, port, p.LocalPort())
	}

	in, _ := decode(d, frame(t, false, &layers.TCP{SrcPort: 443, DstPort: 51000, ACK: true}, []byte{0x17, 0x03, 0x03, 0, 5, 1, 2, 3, 4, 5}))
	if in.Dir != In || in.Plaintext {
		t.Errorf("incoming tls: %+v", in)
	}
}

func TestDecodeDNS(t *testing.T) {
	dns := &layers.DNS{
		ID: 1, QR: true, Questions: []layers.DNSQuestion{{Name: []byte("www.bbc.co.uk"), Type: layers.DNSTypeA, Class: layers.DNSClassIN}},
		Answers: []layers.DNSResourceRecord{
			{Name: []byte("www.bbc.co.uk"), Type: layers.DNSTypeCNAME, Class: layers.DNSClassIN, CNAME: []byte("bbc.map.fastly.net")},
			{Name: []byte("bbc.map.fastly.net"), Type: layers.DNSTypeA, Class: layers.DNSClassIN, IP: theirIP.AsSlice()},
		},
	}
	buf := gopacket.NewSerializeBuffer()
	if err := dns.SerializeTo(buf, gopacket.SerializeOptions{FixLengths: true}); err != nil {
		t.Fatal(err)
	}
	p, _ := decode(NewDecoder(ourMAC), frame(t, false, &layers.UDP{SrcPort: 53, DstPort: 60000}, buf.Bytes()))
	if len(p.Names) != 1 || p.Names[0].Addr != theirIP || p.Names[0].Host != "www.bbc.co.uk" {
		t.Errorf("names = %+v", p.Names)
	}
}

// a real ClientHello, from crypto/tls, so the parser sees what browsers send
func clientHello(t testing.TB, server string, padding int) []byte {
	t.Helper()
	client, peer := net.Pipe()
	defer peer.Close()
	cfg := &tls.Config{ServerName: server, InsecureSkipVerify: true}
	if padding > 0 {
		// a long alpn list stands in for the post-quantum key share that makes
		// browsers' hellos too big for one segment
		protos := []string{}
		for i := 0; i < padding/32; i++ {
			protos = append(protos, "padding-padding-padding-padding")
		}
		cfg.NextProtos = protos
	}
	go tls.Client(client, cfg).Handshake()
	buf := make([]byte, 64<<10)
	peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := peer.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	client.Close()
	return buf[:n]
}

func TestSNI(t *testing.T) {
	hello := clientHello(t, "www.abc.net.au", 0)
	if name, more := clientHelloSNI(hello); name != "www.abc.net.au" || more {
		t.Errorf("whole hello: %q more=%v", name, more)
	}
}

func TestSNISplitAcrossSegments(t *testing.T) {
	hello := clientHello(t, "split.example.org", 3000)
	if len(hello) < 2000 {
		t.Fatalf("hello's only %d bytes - want it to need two segments", len(hello))
	}
	d := NewDecoder(ourMAC)
	first, _ := decode(d, frame(t, true, &layers.TCP{SrcPort: 51001, DstPort: 443, ACK: true, PSH: true}, hello[:1400]))
	second, _ := decode(d, frame(t, true, &layers.TCP{SrcPort: 51001, DstPort: 443, ACK: true, PSH: true}, hello[1400:]))
	if first.SNI != "" && second.SNI != "" {
		t.Fatalf("named twice: %q, %q", first.SNI, second.SNI)
	}
	if got := first.SNI + second.SNI; got != "split.example.org" {
		t.Errorf("sni = %q", got)
	}
	if len(d.hellos) != 0 {
		t.Errorf("%d hellos left waiting", len(d.hellos))
	}
}

func TestSelfICMP(t *testing.T) {
	SelfICMPID.Store(0x1234)
	defer SelfICMPID.Store(0)
	d := NewDecoder(ourMAC)
	echo := []byte{8, 0, 0, 0, 0x12, 0x34, 0, 1}
	inner := append([]byte{0x45, 0, 0, 28, 0, 0, 0, 0, 1, 1, 0, 0, 192, 168, 1, 20, 1, 1, 1, 1}, echo...)
	exceeded := append([]byte{11, 0, 0, 0, 0, 0, 0, 0}, inner...)
	if !d.selfICMP(ICMP, echo) || !d.selfICMP(ICMP, exceeded) {
		t.Error("our own probes should be recognised")
	}
	if d.selfICMP(ICMP, []byte{8, 0, 0, 0, 0x99, 0x99, 0, 1}) {
		t.Error("someone else's ping isn't ours")
	}
}

func sock(pid int32, proto procs.Proto, localPort uint16, remote string, remotePort uint16) procs.Sock {
	s := procs.Sock{Pid: pid, Name: "p", Proto: proto, LocalPort: localPort, RemotePort: remotePort}
	if remote != "" {
		s.RemoteAddr = netip.MustParseAddr(remote)
	}
	return s
}

func index(flows ...flow) Index {
	f := NewFlows()
	for _, fl := range flows {
		f.flows[fl.id] = fl
	}
	f.dirty = true
	f.publish()
	return f.Index()
}

func TestMatchOrder(t *testing.T) {
	connected := flow{id: 2, sock: sock(100, procs.TCP, 51000, theirIP.String(), 443)}
	listener := flow{id: 1, sock: sock(200, procs.TCP, 51000, "", 0)}
	idx := index(connected, listener)

	out := Packet{Dir: Out, Proto: TCP, Src: ourIP, Dst: theirIP, SrcPort: 51000, DstPort: 443}
	if m, ok := idx.match(&out); !ok || m.Sock.Pid != 100 || m.FlowID != 2 {
		t.Errorf("outgoing should match the connected flow, got %+v", m.Sock)
	}
	in := Packet{Dir: In, Proto: TCP, Src: theirIP, Dst: ourIP, SrcPort: 443, DstPort: 51000}
	if m, ok := idx.match(&in); !ok || m.Sock.Pid != 100 {
		t.Errorf("incoming should match the connected flow, got %+v", m.Sock)
	}
	// a different remote on the same local port falls through to the listener
	other := Packet{Dir: In, Proto: TCP, Src: netip.MustParseAddr("8.8.8.8"), Dst: ourIP, SrcPort: 999, DstPort: 51000}
	if m, ok := idx.match(&other); !ok || m.Sock.Pid != 200 {
		t.Errorf("should fall back to the listener, got %+v", m.Sock)
	}
	// wrong direction guess still matches - and gets put right
	flipped := out
	flipped.Dir = In
	if m, ok := idx.match(&flipped); !ok || m.Sock.Pid != 100 || m.Dir != Out {
		t.Errorf("a wrong direction guess should still match, and be sent: got %+v, dir %v", m.Sock, m.Dir)
	}
	flipped = in
	flipped.Dir = Out
	if m, _ := idx.match(&flipped); m.Dir != In {
		t.Errorf("should be put right as received, got %v", m.Dir)
	}
}

func TestMatchSystem(t *testing.T) {
	idx := index()
	bcast := Packet{Dir: In, Broadcast: true, Proto: UDP, SrcPort: 5353, DstPort: 5353}
	if m, ok := idx.match(&bcast); !ok || !m.System {
		t.Error("incoming multicast belongs to no one")
	}
	icmp := Packet{Dir: In, Proto: ICMP}
	if m, ok := idx.match(&icmp); !ok || !m.System {
		t.Error("icmp has no ports to own it by")
	}
	// a fragment past the first has no ports - not anyone's in particular, even with
	// a socket that isn't bound to a port yet
	idx = index(flow{id: 1, sock: sock(3, procs.UDP, 0, "", 0)})
	fragment := Packet{Dir: In, Proto: UDP, Src: theirIP, Dst: ourIP}
	if m, ok := idx.match(&fragment); !ok || !m.System {
		t.Errorf("a fragment should be system traffic, got %+v", m.Sock)
	}
	unknown := Packet{Dir: Out, Proto: TCP, Src: ourIP, Dst: theirIP, SrcPort: 1, DstPort: 2}
	if m, ok := idx.match(&unknown); ok || m.System {
		t.Error("an unknown connection should be unmatched, not system")
	}
}

func TestMalformedDNSHasNoNames(t *testing.T) {
	d := NewDecoder(nil)
	// a 13-byte "answer": a header saying there's one, then nothing - gopacket's
	// parser reads past the end of this
	if names := d.dnsNames([]byte{0, 1, 0x80, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0}); names != nil {
		t.Errorf("got %v", names)
	}
}

func TestOpenBeatsClosed(t *testing.T) {
	closed := flow{id: 1, sock: sock(1, procs.UDP, 5353, "", 0), removed: true}
	open := flow{id: 9, sock: sock(2, procs.UDP, 5353, "", 0)}
	idx := index(closed, open)
	p := Packet{Dir: Out, Proto: UDP, Src: ourIP, Dst: theirIP, SrcPort: 5353, DstPort: 5353}
	if m, _ := idx.match(&p); m.Sock.Pid != 2 {
		t.Errorf("open flow should win, got pid %d", m.Sock.Pid)
	}
}

func TestRetry(t *testing.T) {
	f := NewFlows()
	m := &Matcher{Flows: f}
	p := Packet{Dir: Out, Proto: TCP, Src: ourIP, Dst: theirIP, SrcPort: 51002, DstPort: 443}
	start := time.Now()
	m.retry = append(m.retry, pending{due: start.Add(retryDelay), p: p})

	if got := m.retryDue(start, nil); len(got) != 0 {
		t.Fatal("handed on before its time")
	}
	// the flow shows up while it waits
	f.apply(procs.Event{Kind: procs.Flow, ID: 5, Sock: sock(300, procs.TCP, 51002, theirIP.String(), 443)}, start)
	f.publish()
	got := m.retryDue(start.Add(retryDelay), nil)
	if len(got) != 1 || got[0].Sock.Pid != 300 || len(m.retry) != 0 {
		t.Errorf("retry should have matched pid 300, got %+v", got)
	}
}

func BenchmarkDecode(b *testing.B) {
	d := NewDecoder(ourMAC)
	data := frame(b, false, &layers.TCP{SrcPort: 443, DstPort: 51000, ACK: true}, make([]byte, 1200))
	ci := gopacket.CaptureInfo{Timestamp: time.Now(), Length: len(data)}
	var p Packet
	b.ReportAllocs()
	for b.Loop() {
		d.Decode(data, ci, &p)
	}
}

func BenchmarkMatch(b *testing.B) {
	flows := make([]flow, 0, 1000)
	for i := range 1000 {
		flows = append(flows, flow{id: uint64(i + 1), sock: sock(int32(i), procs.TCP, uint16(40000+i), "151.101.0.81", 443)})
	}
	idx := index(flows...)
	p := Packet{Dir: In, Proto: TCP, Src: theirIP, Dst: ourIP, SrcPort: 443, DstPort: 40500}
	b.ReportAllocs()
	for b.Loop() {
		idx.match(&p)
	}
}
