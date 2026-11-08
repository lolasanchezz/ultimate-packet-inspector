// upi is the agent: it captures every packet on this machine, works out which
// process it belongs to and who's on the other end, and streams it all to the
// desktop app to draw
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/netip"
	"os"
	"os/signal"
	"syscall"
	"time"

	"upi/broadcast"
	"upi/capture"
	"upi/enrich"
	"upi/procs"
	"upi/wire"
)

const usage = `upi - the ultimate packet inspector agent

  upi run      capture, and broadcast to the desktop app (what launchd runs)
  upi dump     capture and print each batch as json instead
  upi install  run at login with launchd
  upi uninstall

the desktop app (desktop/) connects to it on this machine. flags:
`

func main() {
	log.SetFlags(log.Ltime)
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd := os.Args[1]

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	fs.StringVar(&cfg.Listen, "listen", cfg.Listen, "where the desktop app connects (a loopback address)")
	fs.StringVar(&cfg.Name, "name", cfg.Name, "what this machine's called in the app")
	fs.StringVar(&cfg.Iface, "i", cfg.Iface, "interface to capture on")
	fs.Float64Var(&cfg.Interval, "interval", cfg.Interval, "seconds between batches")
	fs.IntVar(&cfg.MaxPPS, "max-pps", cfg.MaxPPS, "record 1 in n packets above this rate (byte counts stay exact)")
	chunks := fs.Bool("chunks", false, "dump: include each batch's packet data")
	runFor := fs.Duration("for", 0, "stop after this long (0 = until interrupted)")
	withApp := fs.Bool("with-app", false, "stop when stdin closes - how the desktop app runs it, so it never outlives the app")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage); fs.PrintDefaults() }
	fs.Parse(os.Args[2:])
	// checked before anything starts, so a bad one's caught straight away
	if (cmd == "run" || cmd == "dump") && !(cfg.Interval > 0) {
		log.Fatalf("the interval has to be more than 0 seconds, not %v - check -interval, or intervalSeconds in config.json", cfg.Interval)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *runFor > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *runFor)
		defer cancel()
	}
	if *withApp {
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		// the app holds the other end. when it goes - quit, crashed, killed - this does too
		go func() {
			io.Copy(io.Discard, os.Stdin)
			cancel()
		}()
	}

	switch cmd {
	case "dump":
		err = run(ctx, cfg, nil, *chunks)
	case "run":
		srv := broadcast.NewServer(broadcast.NewStore(cfg.Name, cfg.Iface))
		ctx, cancel := context.WithCancelCause(ctx)
		go func() {
			if err := srv.Serve(ctx, cfg.Listen); err != nil && ctx.Err() == nil {
				cancel(err)
			}
		}()
		err = run(ctx, cfg, srv, false)
		if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) && !errors.Is(cause, context.DeadlineExceeded) {
			err = cause
		}
	case "install":
		err = install()
	case "uninstall":
		err = uninstall()
	default:
		fs.Usage()
		os.Exit(2)
	}
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		log.Fatal(err)
	}
}

// run is the agent itself. with no server, batches are printed instead of broadcast
func run(ctx context.Context, cfg config, srv *broadcast.Server, withChunks bool) error {
	src, err := capture.Open(cfg.Iface)
	if err != nil {
		return err
	}
	defer src.Close()
	// after the close above, so it runs first: capture's stopped before it's closed
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	dir, _ := configDir()
	// never closed - lookups can still be running as this returns, and the
	// process is on its way out anyway
	geo, geoErr := enrich.OpenGeo(dir)
	if geoErr != nil {
		log.Printf("geo: %v - endpoints won't have locations", geoErr)
	}
	enricher := enrich.NewEnricher(geo)
	enricher.Start(ctx)

	// flow events when we can get them, socket scans when we can't
	flows := capture.NewFlows()
	matcher := &capture.Matcher{Flows: flows}
	flowEvents := make(chan procs.Event, 4096)
	toState := make(chan procs.Event, 4096)
	nstatErr := procs.Start()
	if nstatErr == nil {
		go func() {
			for {
				flowEvents <- procs.Next()
			}
		}()
		go flows.Watch(ctx, flowEvents, toState)
	} else {
		log.Printf("%v - falling back to socket scans", nstatErr)
		rescan := make(chan struct{}, 1)
		matcher.Rescan = rescan
		go flows.Scan(ctx, rescan)
	}

	packets := make(chan capture.Packet, 8192)
	matched := make(chan []capture.Matched, 64)
	go func() {
		if err := src.Run(ctx, packets); err != nil && ctx.Err() == nil {
			log.Print(err)
			cancel()
		}
	}()
	go matcher.Run(ctx, packets, matched)

	homes := make(chan wire.Home, 1)
	go findHome(ctx, cfg, geo, homes)

	batches := make(chan *wire.Batch, 64)
	if srv != nil {
		go broadcaster(ctx, srv, batches)
	} else {
		go dumper(ctx, batches, withChunks)
	}

	st := newState(int32(os.Getpid()), enricher, cfg.Iface, nstatErr == nil, geoErr == nil, cfg.MaxPPS)
	tick := time.NewTicker(time.Duration(cfg.Interval * float64(time.Second)))
	defer tick.Stop()
	log.Printf("capturing on %s, a batch every %gs", cfg.Iface, cfg.Interval)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case batch := <-matched:
			st.packets(batch)
		case ev := <-toState:
			st.flow(ev)
		case v := <-enricher.Out:
			st.enriched(v)
		case h := <-homes:
			st.setHome(h)
		case now := <-tick.C:
			select {
			case batches <- st.batch(now, src.Dropped()):
			default:
				log.Print("broadcasting is falling behind - dropped a batch")
			}
		}
	}
}

// where this machine is: pinned in the config, or wherever its public address is.
// that's asked until there's an answer - at login the network's often not up yet
func findHome(ctx context.Context, cfg config, geo *enrich.Geo, out chan<- wire.Home) {
	if cfg.Home != nil {
		out <- wire.Home{Lat: cfg.Home.Lat, Lon: cfg.Home.Lon, Place: cfg.Home.Place}
		return
	}
	var ip netip.Addr
	for wait := 10 * time.Second; ; wait = min(2*wait, 5*time.Minute) {
		var err error
		if ip, err = enrich.PublicIP(ctx); err == nil {
			break
		}
		log.Printf("couldn't find this machine's public address (%v) - trying again in %v, or set home in the config to place it", err, wait)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
	p, ok := geo.Place(ip)
	if !ok {
		log.Printf("no location for %s - set home in the config to place it", ip)
		return
	}
	place := p.City
	if p.CountryCode != "" {
		place += ", " + p.CountryCode
	}
	log.Printf("home is %s (from %s)", place, ip)
	out <- wire.Home{Lat: p.Lat, Lon: p.Lon, Place: place}
}

// hands each batch to the server. it's here rather than in the loop above so
// a slow app can't hold up capture
func broadcaster(ctx context.Context, srv *broadcast.Server, batches <-chan *wire.Batch) {
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-batches:
			srv.Publish(b)
		}
	}
}

func dumper(ctx context.Context, batches <-chan *wire.Batch, withChunks bool) {
	enc := json.NewEncoder(os.Stdout)
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-batches:
			if !withChunks {
				for i := range b.Chunks {
					b.Chunks[i].Data = ""
				}
			}
			enc.Encode(b)
		}
	}
}
