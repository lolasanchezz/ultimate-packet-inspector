// build-owners turns DuckDuckGo's tracker blocklist (CC BY-NC-SA 4.0, from
// github.com/duckduckgo/tracker-blocklists) into the compact table enrich embeds:
// who owns each domain, and what its tracking is for
//
//	go run ./cmd/build-owners > enrich/data/owners.json.gz
package main

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"
)

const tdsURL = "https://staticcdn.duckduckgo.com/trackerblocking/v6/current/extension-tds.json"

type tds struct {
	Trackers map[string]struct {
		Owner struct {
			Name    string `json:"name"`
			OwnedBy string `json:"ownedBy"`
		} `json:"owner"`
		Categories []string `json:"categories"`
		Default    string   `json:"default"`
	} `json:"trackers"`
	Entities map[string]struct {
		DisplayName string `json:"displayName"`
	} `json:"entities"`
	Domains map[string]string `json:"domains"` // domain -> entity
}

// what enrich reads - see enrich/owners.go
type table struct {
	Owners     []string             `json:"owners"`
	Categories []string             `json:"categories"`
	Domains    map[string][3]uint64 `json:"domains"` // owner index, category bits, 1 if a tracker
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "build-owners:", err)
		os.Exit(1)
	}
}

func run() error {
	res, err := http.Get(tdsURL)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", tdsURL, res.Status)
	}
	var src tds
	if err := json.NewDecoder(res.Body).Decode(&src); err != nil {
		return err
	}

	t := table{Domains: make(map[string][3]uint64)}
	ownerIdx := map[string]uint64{}
	owner := func(entity string) uint64 {
		name := displayName(entity, src.Entities[entity].DisplayName)
		if i, ok := ownerIdx[name]; ok {
			return i
		}
		ownerIdx[name] = uint64(len(t.Owners))
		t.Owners = append(t.Owners, name)
		return ownerIdx[name]
	}
	for domain, entity := range src.Domains {
		t.Domains[domain] = [3]uint64{owner(entity), 0, 0}
	}

	for _, tr := range src.Trackers {
		for _, c := range tr.Categories {
			if !slices.Contains(t.Categories, c) {
				t.Categories = append(t.Categories, c)
			}
		}
	}
	slices.Sort(t.Categories)
	if len(t.Categories) > 64 {
		return fmt.Errorf("%d categories won't fit in a bitmask", len(t.Categories))
	}
	for domain, tr := range src.Trackers {
		entity := tr.Owner.OwnedBy
		if entity == "" {
			entity = tr.Owner.Name
		}
		var bits uint64
		for _, c := range tr.Categories {
			bits |= 1 << slices.Index(t.Categories, c)
		}
		tracker := uint64(0)
		if tr.Default == "block" || bits != 0 {
			tracker = 1
		}
		t.Domains[domain] = [3]uint64{owner(entity), bits, tracker}
	}

	gz := gzip.NewWriter(os.Stdout)
	if err := json.NewEncoder(gz).Encode(t); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "%d domains, %d owners, %d categories\n", len(t.Domains), len(t.Owners), len(t.Categories))
	return gz.Close()
}

// "Youtube (Google)" is owned by Google - the bit in brackets is the parent
func displayName(entity, display string) string {
	if display == "" {
		return entity
	}
	if i := strings.LastIndex(display, " ("); i > 0 && strings.HasSuffix(display, ")") {
		return display[i+2 : len(display)-1]
	}
	return display
}
