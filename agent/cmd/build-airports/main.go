// build-airports turns OurAirports' airport list (public domain) into the small
// table enrich uses to place routers named after the airport they're near
// (ae-1.r21.sea01..., be3271.ccr41.lax04...)
//
//	go run ./cmd/build-airports > enrich/data/airports.csv.gz
package main

import (
	"compress/gzip"
	"encoding/csv"
	"fmt"
	"net/http"
	"os"
	"strings"
)

const airportsURL = "https://davidmegginson.github.io/ourairports-data/airports.csv"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "build-airports:", err)
		os.Exit(1)
	}
}

func run() error {
	res, err := http.Get(airportsURL)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", airportsURL, res.Status)
	}
	r := csv.NewReader(res.Body)
	header, err := r.Read()
	if err != nil {
		return err
	}
	col := map[string]int{}
	for i, h := range header {
		col[h] = i
	}

	gz := gzip.NewWriter(os.Stdout)
	w := csv.NewWriter(gz)
	n := 0
	for {
		rec, err := r.Read()
		if err != nil {
			break
		}
		kind, iata := rec[col["type"]], strings.ToLower(rec[col["iata_code"]])
		// only airports big enough to have routers named after them
		if (kind != "large_airport" && kind != "medium_airport") || rec[col["scheduled_service"]] != "yes" || len(iata) != 3 {
			continue
		}
		w.Write([]string{iata, rec[col["latitude_deg"]], rec[col["longitude_deg"]], rec[col["municipality"]], rec[col["iso_country"]], kind[:1]})
		n++
	}
	w.Flush()
	fmt.Fprintf(os.Stderr, "%d airports\n", n)
	return gz.Close()
}
