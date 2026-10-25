package enrich

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"strings"
	"sync"

	"golang.org/x/net/publicsuffix"
)

// who owns which domains, and what the tracking ones are for - built from
// DuckDuckGo's tracker blocklist (CC BY-NC-SA 4.0) by cmd/build-owners
//
//go:embed data/owners.json.gz
var ownersGz []byte

// Owner is the company behind a hostname
type Owner struct {
	Name       string   `json:"name"`
	Categories []string `json:"categories"` // what its tracking is for - empty if it isn't a tracker
	Tracker    bool     `json:"tracker"`
}

var owners = sync.OnceValue(func() (t struct {
	Owners     []string             `json:"owners"`
	Categories []string             `json:"categories"`
	Domains    map[string][3]uint64 `json:"domains"`
}) {
	r, err := gzip.NewReader(bytes.NewReader(ownersGz))
	if err == nil {
		err = json.NewDecoder(r).Decode(&t)
	}
	if err != nil {
		panic("enrich: embedded owners table is broken: " + err.Error())
	}
	return t
})

// OwnerOf finds who's behind a hostname, trying it and then each parent domain
// up to the registrable one (a.b.doubleclick.net, b.doubleclick.net, doubleclick.net)
func OwnerOf(host string) (Owner, bool) {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == "" {
		return Owner{}, false
	}
	t := owners()
	root, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil {
		root = host
	}
	for name := host; ; {
		if d, ok := t.Domains[name]; ok {
			o := Owner{Name: t.Owners[d[0]], Tracker: d[2] == 1}
			for i, c := range t.Categories {
				if d[1]&(1<<i) != 0 {
					o.Categories = append(o.Categories, c)
				}
			}
			return o, true
		}
		dot := strings.IndexByte(name, '.')
		if name == root || dot < 0 {
			return Owner{}, false
		}
		name = name[dot+1:]
	}
}
