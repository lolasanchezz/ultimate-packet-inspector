package capture

// looking inside payloads for the little the agent wants: hostnames, and whether
// anything's going over the wire unencrypted. payload contents never leave here

import (
	"net/netip"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
)

func isDNSPort(p uint16) bool { return p == 53 || p == 5353 }

// names from a dns (or mdns) answer. gopacket's dns parser can panic on a
// malformed one (it doesn't check every length), and anyone on the network can
// send one - so a bad answer just has no names
func (d *Decoder) dnsNames(payload []byte) (names []Name) {
	defer func() {
		if recover() != nil {
			names = nil
		}
	}()
	if d.dns.DecodeFromBytes(payload, gopacket.NilDecodeFeedback) != nil || !d.dns.QR {
		return nil
	}
	asked := ""
	if len(d.dns.Questions) > 0 {
		asked = string(d.dns.Questions[0].Name)
	}
	for _, a := range d.dns.Answers {
		if (a.Type != layers.DNSTypeA && a.Type != layers.DNSTypeAAAA) || a.IP == nil {
			continue
		}
		// the name the app asked for reads better than the end of a cname chain
		host := asked
		if host == "" {
			host = string(a.Name)
		}
		names = append(names, Name{Addr: addr(a.IP), Host: host})
	}
	return names
}

// tls ClientHellos waiting on their next segment, by connection. modern hellos
// (post-quantum key shares) are ~1.8KB, so the server name is often in the second
type hellos map[helloKey][]byte

type helloKey struct {
	src, dst         netip.Addr
	srcPort, dstPort uint16
}

const (
	maxHellos    = 256
	maxHelloSize = 16 << 10
)

func (h hellos) sni(p *Packet, payload []byte) string {
	key := helloKey{p.Src, p.Dst, p.SrcPort, p.DstPort}
	buf, waiting := h[key]
	if !waiting {
		if len(payload) < 9 || payload[0] != 0x16 || payload[1] != 0x03 {
			return "" // the usual case - not the start of a hello
		}
		name, more := clientHelloSNI(payload)
		if more {
			if len(h) >= maxHellos {
				clear(h) // something's opening connections and never finishing them
			}
			h[key] = append([]byte(nil), payload...)
		}
		return name
	}

	buf = append(buf, payload...)
	name, more := clientHelloSNI(buf)
	if more && len(buf) < maxHelloSize {
		h[key] = buf
	} else {
		delete(h, key)
	}
	return name
}

// the server name from a tls ClientHello. more is true when b is the start of a
// hello that runs past its end and the name hasn't turned up yet
func clientHelloSNI(b []byte) (name string, more bool) {
	// record header: type 22 (handshake), version, length. then the handshake type
	if len(b) < 9 || b[0] != 0x16 || b[1] != 0x03 || b[5] != 0x01 { // 0x01 = ClientHello
		return "", false
	}
	recordLen := int(b[3])<<8 | int(b[4])
	if name = sniIn(b[9:]); name != "" {
		return name, false
	}
	return "", len(b) < 5+recordLen
}

// walks a ClientHello's body to the server_name extension. anything cut off by the
// end of b just returns ""
func sniIn(b []byte) string {
	skip := func(n int) bool {
		if n > len(b) {
			return false
		}
		b = b[n:]
		return true
	}
	u8 := func() int {
		if len(b) < 1 {
			return 1 << 30
		}
		return int(b[0])
	}
	u16 := func() int {
		if len(b) < 2 {
			return 1 << 30
		}
		return int(b[0])<<8 | int(b[1])
	}

	// version + random, session id, cipher suites, compression methods, extensions length
	if !skip(34) || !skip(1+u8()) || !skip(2+u16()) || !skip(1+u8()) || !skip(2) {
		return ""
	}
	for len(b) >= 4 {
		typ := int(b[0])<<8 | int(b[1])
		n := int(b[2])<<8 | int(b[3])
		b = b[4:]
		if n > len(b) {
			return ""
		}
		if typ == 0 { // server_name: list length, name type (0 = host), name length, name
			ext := b[:n]
			if len(ext) < 5 || ext[2] != 0 {
				return ""
			}
			nameLen := int(ext[3])<<8 | int(ext[4])
			if 5+nameLen > len(ext) {
				return ""
			}
			return string(ext[5 : 5+nameLen])
		}
		b = b[n:]
	}
	return ""
}

// ports where payloads are encrypted, or where plaintext is normal and not interesting
func quietPort(p uint16) bool {
	switch p {
	case 22, 53, 443, 465, 853, 993, 995, 1900, 5223, 5353, 8443:
		return true
	}
	return false
}

// whether a payload has readable text in it - a run of printable ascii long
// enough that it's words, not chance (a run of 24 in random bytes is ~1 in 10^10)
func looksPlaintext(b []byte) bool {
	// tls records (handshake, alert, app data) are binary apart from the odd hostname
	if len(b) >= 3 && b[0] >= 0x14 && b[0] <= 0x17 && b[1] == 0x03 {
		return false
	}
	run, letters := 0, 0
	for _, c := range b {
		if (c >= 0x20 && c < 0x7f) || c == '\n' || c == '\r' || c == '\t' {
			run++
			if l := c | 0x20; l >= 'a' && l <= 'z' {
				letters++
			}
			if run >= 24 && letters >= 16 {
				return true
			}
			continue
		}
		run, letters = 0, 0
	}
	return false
}
