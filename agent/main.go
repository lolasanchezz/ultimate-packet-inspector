// upi is the agent: it captures every packet on this machine, works out which
// process it belongs to and who's on the other end, and streams it all to
// SpacetimeDB for the website to draw
package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"upi/capture"
	"upi/enrich"
	"upi/procs"
	"upi/upload"
)

const usage = `upi - the ultimate packet inspector agent

  upi run      capture + upload to SpacetimeDB (what launchd runs)
  upi start    print a pairing code, then run
  upi dump     capture and print each batch as json, without uploading
  upi pair     print a code for pairing the website with this machine
  upi revoke   unpair every website viewer from this machine
  upi install  run at login with launchd
  upi uninstall

where the database is comes from UPI_SERVER, UPI_DB and UPI_SITE in the repo's
.env (or the environment) - see .env.example. flags override them:
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
	envFile := applyEnv(&cfg)
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	fs.StringVar(&cfg.Server, "server", cfg.Server, "SpacetimeDB host")
	fs.StringVar(&cfg.Database, "db", cfg.Database, "the database the module is published as")
	fs.StringVar(&cfg.Site, "site", cfg.Site, "the website's url, for pairing links")
	fs.StringVar(&cfg.Name, "name", cfg.Name, "what this machine's called on the website")
	fs.StringVar(&cfg.Iface, "i", cfg.Iface, "interface to capture on")
	fs.Float64Var(&cfg.Interval, "interval", cfg.Interval, "seconds between uploads")
	fs.IntVar(&cfg.MaxPPS, "max-pps", cfg.MaxPPS, "record 1 in n packets above this rate (byte counts stay exact)")
	chunks := fs.Bool("chunks", false, "dump: include each batch's packet data")
	runFor := fs.Duration("for", 0, "stop after this long (0 = until interrupted)")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage); fs.PrintDefaults() }
	fs.Parse(os.Args[2:])
	// checked before anything's saved, so a bad one can't get stuck in the config
	if (cmd == "run" || cmd == "start" || cmd == "dump") && !(cfg.Interval > 0) {
		log.Fatalf("the interval has to be more than 0 seconds, not %v - check -interval, or intervalSeconds in config.json", cfg.Interval)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *runFor > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *runFor)
		defer cancel()
	}

	if envFile != "" && cmd != "install" && cmd != "uninstall" {
		log.Printf("settings from %s", envFile)
	}

	switch cmd {
	case "dump":
		err = run(ctx, cfg, nil, *chunks)
	case "run":
		var client *upload.Client
		if client, err = connect(ctx, &cfg); err == nil {
			err = run(ctx, cfg, client, false)
		}
	case "start":
		var client *upload.Client
		if client, err = connect(ctx, &cfg); err == nil {
			if err = pair(ctx, cfg, client); err == nil {
				err = run(ctx, cfg, client, false)
			}
		}
	case "pair":
		var client *upload.Client
		if client, err = connect(ctx, &cfg); err == nil {
			err = pair(ctx, cfg, client)
		}
	case "revoke":
		var client *upload.Client
		if client, err = connect(ctx, &cfg); err == nil {
			err = client.Call(ctx, "revoke_viewers")
		}
		if err == nil {
			fmt.Println("every viewer's been unpaired")
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

// connect makes sure the agent has an identity and this machine is registered
func connect(ctx context.Context, cfg *config) (*upload.Client, error) {
	if cfg.Database == "" {
		return nil, errors.New("no database yet - set UPI_DB in the repo's .env (see .env.example), or pass -db")
	}
	// a token only works on the server that made it. one saved before this was
	// kept has been working where it is
	server := strings.TrimSuffix(cfg.Server, "/")
	if cfg.Token != "" && cfg.TokenServer == "" {
		cfg.TokenServer = server
	}
	if cfg.Token == "" || cfg.TokenServer != server {
		id, token, err := upload.NewIdentity(ctx, cfg.Server)
		if err != nil {
			return nil, err
		}
		cfg.Identity, cfg.Token, cfg.TokenServer = id, token, server
		log.Printf("made a new identity for this machine on %s: %s", server, id)
	}
	if err := saveConfig(*cfg); err != nil {
		return nil, fmt.Errorf("saving config: %w", err)
	}
	client := upload.NewClient(cfg.Server, cfg.Database, cfg.Token)
	if err := client.Call(ctx, "register_machine", cfg.Name, cfg.Iface); err != nil {
		return nil, fmt.Errorf("registering with %s/%s: %w", cfg.Server, cfg.Database, err)
	}
	return client, nil
}

// pair makes a one-time code for the website. it's good for ten minutes
func pair(ctx context.Context, cfg config, client *upload.Client) error {
	const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789" // nothing that reads as something else
	b := make([]byte, 8)
	rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	code := string(b)
	if err := client.Call(ctx, "set_pair_code", code); err != nil {
		return err
	}
	fmt.Printf("pairing code: %s-%s (good for 10 minutes)\n", code[:4], code[4:])
	if cfg.Site != "" {
		// the link carries the database (and server, if it isn't maincloud) so the
		// site needs nothing set up to use it
		link := fmt.Sprintf("%s/#pair=%s&db=%s", strings.TrimSuffix(cfg.Site, "/"), code, url.QueryEscape(cfg.Database))
		if cfg.Server != "https://maincloud.spacetimedb.com" {
			link += "&server=" + url.QueryEscape(strings.Replace(cfg.Server, "http", "ws", 1))
		}
		fmt.Printf("or open %s\n", link)
	}
	return nil
}

// run is the agent itself. with no client, batches are printed instead of uploaded
func run(ctx context.Context, cfg config, client *upload.Client, withChunks bool) error {
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

	homes := make(chan upload.Home, 1)
	go findHome(ctx, cfg, geo, homes)

	batches := make(chan *upload.Batch, 64)
	if client != nil {
		go uploader(ctx, client, batches)
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
				log.Print("uploads are falling behind - dropped a batch")
			}
		}
	}
}

// where this machine is: pinned in the config, or wherever its public address is.
// that's asked until there's an answer - at login the network's often not up yet
func findHome(ctx context.Context, cfg config, geo *enrich.Geo, out chan<- upload.Home) {
	if cfg.Home != nil {
		out <- upload.Home{Lat: cfg.Home.Lat, Lon: cfg.Home.Lon, Place: cfg.Home.Place}
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
	out <- upload.Home{Lat: p.Lat, Lon: p.Lon, Place: place}
}

// uploads one batch at a time, trying a few times before giving up on one
func uploader(ctx context.Context, client *upload.Client, batches <-chan *upload.Batch) {
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-batches:
			for attempt := 1; ; attempt++ {
				err := client.Ingest(ctx, b)
				if err == nil || ctx.Err() != nil {
					break
				}
				if attempt == 3 {
					log.Printf("upload failed, skipping a batch: %v", err)
					break
				}
				time.Sleep(time.Duration(attempt) * time.Second)
			}
		}
	}
}

func dumper(ctx context.Context, batches <-chan *upload.Batch, withChunks bool) {
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
