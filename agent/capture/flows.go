package capture

import (
	"context"
	"net/netip"
	"sync/atomic"
	"time"

	"upi/procs"
)

// how long a closed flow sticks around, so its last few packets still match
const flowGrace = 3 * time.Second

// what a packet gets matched on. listeners + unconnected udp have no remote end
type flowKey struct {
	proto      uint8
	localPort  uint16
	remote     netip.Addr
	remotePort uint16
}

func keyOf(s procs.Sock) flowKey {
	return flowKey{proto: uint8(s.Proto), localPort: s.LocalPort, remote: s.RemoteAddr, remotePort: s.RemotePort}
}

type flow struct {
	id        uint64 // 0 for sockets from a scan
	sock      procs.Sock
	removed   bool
	removedAt time.Time
}

// when two flows share a key (lots of processes listen on udp 5353), open beats
// closed, then the oldest wins - so the pick doesn't flip around between rebuilds
func betterFlow(a, b flow) bool {
	if a.removed != b.removed {
		return !a.removed
	}
	return a.id < b.id
}

// Index is what packets get matched against. it's built whole and never changed
// after, so the matcher reads it without locks
type Index map[flowKey]flow

// Flows keeps track of every open flow and publishes an Index of them. only the
// goroutine running Watch, or Scan when flow events aren't available, changes it
type Flows struct {
	index   atomic.Pointer[Index]
	flows   map[uint64]flow
	scanned []procs.Sock
	dirty   bool
}

func NewFlows() *Flows {
	f := &Flows{flows: make(map[uint64]flow)}
	f.index.Store(&Index{})
	return f
}

func (f *Flows) Index() Index { return *f.index.Load() }

func (f *Flows) apply(ev procs.Event, now time.Time) {
	switch ev.Kind {
	case procs.Flow:
		old, existed := f.flows[ev.ID]
		f.flows[ev.ID] = flow{id: ev.ID, sock: ev.Sock}
		// the index only cares about addresses, so skip the rebuild if those didn't move
		f.dirty = f.dirty || !existed || old.removed || keyOf(old.sock) != keyOf(ev.Sock) || old.sock.Pid != ev.Sock.Pid
	case procs.Removed:
		if fl, ok := f.flows[ev.ID]; ok && !fl.removed {
			fl.removed, fl.removedAt = true, now
			f.flows[ev.ID] = fl
			f.dirty = true
		}
	}
}

func (f *Flows) prune(now time.Time) {
	for id, fl := range f.flows {
		if fl.removed && now.Sub(fl.removedAt) > flowGrace {
			delete(f.flows, id)
			f.dirty = true
		}
	}
}

func (f *Flows) publish() {
	if !f.dirty {
		return
	}
	f.dirty = false
	idx := make(Index, len(f.flows)+len(f.scanned))
	add := func(fl flow) {
		k := keyOf(fl.sock)
		if old, ok := idx[k]; !ok || betterFlow(fl, old) {
			idx[k] = fl
		}
	}
	for _, s := range f.scanned {
		add(flow{sock: s})
	}
	for _, fl := range f.flows {
		add(fl)
	}
	f.index.Store(&idx)
}

// Watch applies flow events as they come, keeping the index fresh, and passes
// each one on to fwd for everything that isn't matching (rtt, open/closed)
func (f *Flows) Watch(ctx context.Context, events <-chan procs.Event, fwd chan<- procs.Event) {
	prune := time.NewTicker(time.Second)
	defer prune.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-prune.C:
			f.prune(now)
			f.publish()
		case ev := <-events:
			now := time.Now()
			f.apply(ev, now)
			fwd <- ev
			// take everything that's already waiting before rebuilding, so a burst of
			// events is one rebuild, not hundreds
			for drained := false; !drained; {
				select {
				case ev := <-events:
					f.apply(ev, now)
					fwd <- ev
				default:
					drained = true
				}
			}
			f.publish()
		}
	}
}

// Scan is the fallback for when flow events aren't available: a socket scan
// every couple of seconds, and sooner when the matcher asks for one
func (f *Flows) Scan(ctx context.Context, wanted <-chan struct{}) {
	const every, gap = 2 * time.Second, 250 * time.Millisecond
	timer := time.NewTimer(0)
	defer timer.Stop()
	last := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-wanted:
			if wait := gap - time.Since(last); wait > 0 {
				time.Sleep(wait)
			}
		case <-timer.C:
		}
		f.scanned = procs.Scan()
		f.dirty = true
		f.publish()
		last = time.Now()
		timer.Reset(every)
	}
}
