package capture

import (
	"context"
	"time"

	"upi/procs"
)

const (
	// how long an unmatched packet waits for its flow to show up. a new
	// connection's first packets can beat its flow's description
	retryDelay = 150 * time.Millisecond
	batchSize  = 512
	batchEvery = 20 * time.Millisecond
)

// Matched is a packet and whoever it belongs to
type Matched struct {
	Packet
	FlowID uint64     // 0 when it came from a socket scan, or nothing matched
	Sock   procs.Sock // zero when nothing matched
	System bool       // nothing could own it - broadcast, multicast, no ports
}

// match tries the connection both ways round (the direction guess comes from the
// mac address, which is right nearly always), then listeners/unconnected udp on
// the local port. a listener only gets a packet if no connected socket fits it
func (x Index) match(p *Packet) (Matched, bool) {
	m := Matched{Packet: *p}
	// broadcast/multicast from another machine reaches every listener on that port,
	// so there's no one process to give it to. (one we sent still has a sender)
	if p.Broadcast && p.Dir == In {
		m.System = true
		return m, true
	}
	if p.Proto != TCP && p.Proto != UDP {
		m.System = true
		return m, true
	}
	// no ports: a fragment (only the first carries them) - there's no telling whose
	// it is without putting the packet back together
	if p.SrcPort == 0 && p.DstPort == 0 {
		m.System = true
		return m, true
	}

	sent := flowKey{proto: p.Proto, localPort: p.SrcPort, remote: p.Dst, remotePort: p.DstPort}
	received := flowKey{proto: p.Proto, localPort: p.DstPort, remote: p.Src, remotePort: p.SrcPort}
	if p.Dir == In {
		sent, received = received, sent
	}
	for i, k := range [...]flowKey{sent, received, {proto: p.Proto, localPort: p.LocalPort()}} {
		if fl, ok := x[k]; ok {
			m.FlowID, m.Sock = fl.id, fl.sock
			// it only fits the other way round, so the direction guess was wrong - the
			// flow knows which end is ours
			if i == 1 {
				m.Dir = Out - m.Dir
			}
			return m, true
		}
	}
	m.System = p.Broadcast
	return m, false
}

// Matcher hands every packet on with its process, giving unmatched ones a
// moment for their flow to show up first
type Matcher struct {
	Flows *Flows
	// asks for a fresh socket scan - only set when flow events aren't available
	Rescan chan<- struct{}
	retry  []pending
}

type pending struct {
	due time.Time
	p   Packet
}

// Run matches packets from in until ctx is done, handing them to out a batch at a
// time so the next stage isn't woken for every packet
func (m *Matcher) Run(ctx context.Context, in <-chan Packet, out chan<- []Matched) {
	tick := time.NewTicker(batchEvery)
	defer tick.Stop()
	batch := make([]Matched, 0, batchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		select {
		case out <- batch:
		case <-ctx.Done():
		}
		batch = make([]Matched, 0, batchSize)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case p := <-in:
			idx := m.Flows.Index()
			if mt, ok := idx.match(&p); ok || mt.System {
				batch = append(batch, mt)
			} else {
				m.retry = append(m.retry, pending{due: time.Now().Add(retryDelay), p: p})
			}
			if len(batch) >= batchSize {
				flush()
			}
		case now := <-tick.C:
			batch = m.retryDue(now, batch)
			flush()
		}
	}
}

// second tries - whatever still doesn't match goes on unmatched. packets wait
// the same time, so the ones due are always at the front
func (m *Matcher) retryDue(now time.Time, batch []Matched) []Matched {
	if len(m.retry) == 0 {
		return batch
	}
	idx := m.Flows.Index()
	n := 0
	for ; n < len(m.retry) && !now.Before(m.retry[n].due); n++ {
		mt, ok := idx.match(&m.retry[n].p)
		if !ok && m.Rescan != nil {
			select {
			case m.Rescan <- struct{}{}:
			default: // one's already on its way
			}
		}
		batch = append(batch, mt)
	}
	m.retry = append(m.retry[:0], m.retry[n:]...)
	return batch
}
