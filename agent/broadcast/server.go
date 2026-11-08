package broadcast

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"upi/wire"
)

// DefaultListen is where the agent and the desktop app meet unless told otherwise
const DefaultListen = "127.0.0.1:7323"

// AppOrigin is the desktop app's origin - where wails serves its page from
const AppOrigin = "wails://wails"

// Server streams the store to every app listening, as server-sent events:
// "snapshot" with everything when one connects, then "update" with what each
// batch changed
type Server struct {
	mu      sync.Mutex
	store   *Store
	clients map[chan []byte]struct{}
}

func NewServer(store *Store) *Server {
	return &Server{store: store, clients: map[chan []byte]struct{}{}}
}

// Publish takes in a batch and sends what changed to everyone listening
func (s *Server) Publish(b *wire.Batch) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.Marshal(s.store.Ingest(b, time.Now()))
	if err != nil {
		log.Printf("broadcast: %v", err)
		return
	}
	msg := event("update", data)
	for c := range s.clients {
		select {
		case c <- msg:
		default:
			// it's fallen too far behind. closing it ends its stream, and the app
			// reconnects and starts again from a snapshot
			delete(s.clients, c)
			close(c)
		}
	}
}

func event(name string, data []byte) []byte {
	return fmt.Appendf(nil, "event: %s\ndata: %s\n\n", name, data)
}

// Serve listens on addr until ctx is done. it's only ever on this machine: the
// address has to be a loopback one
func (s *Server) Serve(ctx context.Context, addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("%s isn't on this machine - what the agent sees stays on it, so it only listens on a loopback address like %s", addr, DefaultListen)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listening on %s: %w (is another upi running?)", addr, err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /events", s.events)
	srv := &http.Server{Handler: guard(mux), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		srv.Close()
	}()
	log.Printf("broadcasting on http://%s/events", ln.Addr())
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return ctx.Err()
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming isn't supported", http.StatusInternalServerError)
		return
	}
	c := make(chan []byte, 64)
	s.mu.Lock()
	snapshot, err := json.Marshal(s.store.All())
	if err == nil {
		s.clients[c] = struct{}{}
	}
	s.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer func() {
		s.mu.Lock()
		if _, ok := s.clients[c]; ok {
			delete(s.clients, c)
			close(c)
		}
		s.mu.Unlock()
	}()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	w.Write(event("snapshot", snapshot))
	flusher.Flush()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, ok := <-c:
			if !ok {
				return
			}
			if _, err := w.Write(msg); err != nil {
				return
			}
			flusher.Flush()
		case <-ping.C:
			// keeps anything in between from deciding the stream's dead
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// what this machine's doing is only for this machine's apps. a web page in a
// browser can reach localhost too, so: requests have to be addressed to a
// loopback name (no dns rebinding), and pages can only read the stream if
// they're the desktop app, or served from this machine (the site's dev server)
func guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			if !allowedOrigin(origin) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		next.ServeHTTP(w, r)
	})
}

func loopbackHost(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func allowedOrigin(origin string) bool {
	if origin == AppOrigin {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && loopbackHost(u.Host)
}
