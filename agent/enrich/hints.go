package enrich

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/csv"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// routers are usually named after where they are - an airport code
// (ae-1.r21.sea01...), a metro code (be3271.ccr41.lon13.atlas.cogentco.com), a
// telco CLLI code (ae-0.r20.lsanca07.us.bb.gin.ntt.net) or the city itself
// (ae-2-3602.ear2.frankfurt1.level3.net). geo-ip only knows who owns the
// router's address, which is usually the carrier's head office, so a name is a
// much better guess. it's still a guess - physics gets the final say
//
//go:embed data/airports.csv.gz
var airportsGz []byte

type hintPlace struct {
	LatLon
	City, CountryCode string
}

var airports = sync.OnceValue(func() map[string]hintPlace {
	r, err := gzip.NewReader(bytes.NewReader(airportsGz))
	if err != nil {
		panic("enrich: embedded airports table is broken: " + err.Error())
	}
	recs, err := csv.NewReader(r).ReadAll()
	if err != nil {
		panic("enrich: embedded airports table is broken: " + err.Error())
	}
	m := make(map[string]hintPlace, len(recs)+len(extraPlaces))
	for _, rec := range recs {
		lat, _ := strconv.ParseFloat(rec[1], 64)
		lon, _ := strconv.ParseFloat(rec[2], 64)
		m[rec[0]] = hintPlace{LatLon: LatLon{lat, lon}, City: rec[3], CountryCode: rec[4]}
	}
	for code, p := range extraPlaces {
		m[code] = p
	}
	return m
})

// metro codes, CLLI prefixes and city names carriers use that aren't airports
var extraPlaces = map[string]hintPlace{
	"lon": {LatLon{51.507, -0.128}, "London", "GB"}, "lndngb": {LatLon{51.507, -0.128}, "London", "GB"}, "london": {LatLon{51.507, -0.128}, "London", "GB"},
	"nyc": {LatLon{40.713, -74.006}, "New York", "US"}, "nycmny": {LatLon{40.713, -74.006}, "New York", "US"}, "newyork": {LatLon{40.713, -74.006}, "New York", "US"},
	"par": {LatLon{48.857, 2.352}, "Paris", "FR"}, "parsfr": {LatLon{48.857, 2.352}, "Paris", "FR"}, "paris": {LatLon{48.857, 2.352}, "Paris", "FR"},
	"tyo": {LatLon{35.676, 139.650}, "Tokyo", "JP"}, "tokyjp": {LatLon{35.676, 139.650}, "Tokyo", "JP"}, "tokyo": {LatLon{35.676, 139.650}, "Tokyo", "JP"},
	"chi": {LatLon{41.878, -87.630}, "Chicago", "US"}, "chcgil": {LatLon{41.878, -87.630}, "Chicago", "US"}, "chicago": {LatLon{41.878, -87.630}, "Chicago", "US"},
	"was": {LatLon{38.907, -77.037}, "Washington", "US"}, "asbnva": {LatLon{39.044, -77.488}, "Ashburn", "US"}, "ashburn": {LatLon{39.044, -77.488}, "Ashburn", "US"},
	"lsanca": {LatLon{34.052, -118.244}, "Los Angeles", "US"}, "losangeles": {LatLon{34.052, -118.244}, "Los Angeles", "US"},
	"snjsca": {LatLon{37.338, -121.886}, "San Jose", "US"}, "sanjose": {LatLon{37.338, -121.886}, "San Jose", "US"},
	"plalca": {LatLon{37.442, -122.143}, "Palo Alto", "US"}, "paloalto": {LatLon{37.442, -122.143}, "Palo Alto", "US"},
	"sttlwa": {LatLon{47.606, -122.332}, "Seattle", "US"}, "seattle": {LatLon{47.606, -122.332}, "Seattle", "US"},
	"dllstx": {LatLon{32.777, -96.797}, "Dallas", "US"}, "dallas": {LatLon{32.777, -96.797}, "Dallas", "US"},
	"atlnga": {LatLon{33.749, -84.388}, "Atlanta", "US"}, "atlanta": {LatLon{33.749, -84.388}, "Atlanta", "US"},
	"miamfl": {LatLon{25.762, -80.192}, "Miami", "US"}, "miami": {LatLon{25.762, -80.192}, "Miami", "US"},
	"dnvrco": {LatLon{39.739, -104.990}, "Denver", "US"}, "denver": {LatLon{39.739, -104.990}, "Denver", "US"},
	"nwrknj": {LatLon{40.736, -74.172}, "Newark", "US"}, "newark": {LatLon{40.736, -74.172}, "Newark", "US"},
	"frnkge": {LatLon{50.110, 8.682}, "Frankfurt", "DE"}, "frankfurt": {LatLon{50.110, 8.682}, "Frankfurt", "DE"},
	"amstnl": {LatLon{52.368, 4.904}, "Amsterdam", "NL"}, "amsterdam": {LatLon{52.368, 4.904}, "Amsterdam", "NL"},
	"sydnau": {LatLon{-33.869, 151.209}, "Sydney", "AU"}, "sydney": {LatLon{-33.869, 151.209}, "Sydney", "AU"},
	"sngpsg": {LatLon{1.352, 103.820}, "Singapore", "SG"}, "singapore": {LatLon{1.352, 103.820}, "Singapore", "SG"},
	"hngkhk": {LatLon{22.320, 114.169}, "Hong Kong", "HK"}, "hongkong": {LatLon{22.320, 114.169}, "Hong Kong", "HK"},
	"stockholm": {LatLon{59.329, 18.069}, "Stockholm", "SE"}, "sto": {LatLon{59.329, 18.069}, "Stockholm", "SE"},
	"milan": {LatLon{45.464, 9.190}, "Milan", "IT"}, "mil": {LatLon{45.464, 9.190}, "Milan", "IT"},
	"madrid": {LatLon{40.417, -3.704}, "Madrid", "ES"}, "toronto": {LatLon{43.653, -79.383}, "Toronto", "CA"},
	"montreal": {LatLon{45.502, -73.567}, "Montreal", "CA"}, "vancouver": {LatLon{49.283, -123.121}, "Vancouver", "CA"},

	// backbone codes that aren't airports - or are, somewhere else entirely (scl is
	// santiago's airport, but santa clara to most carriers; kcm is in turkey)
	"ash": {LatLon{39.044, -77.488}, "Ashburn", "US"}, "scl": {LatLon{37.354, -121.955}, "Santa Clara", "US"},
	"santaclara": {LatLon{37.354, -121.955}, "Santa Clara", "US"}, "pao": {LatLon{37.442, -122.143}, "Palo Alto", "US"},
	"fmt": {LatLon{37.548, -121.989}, "Fremont", "US"}, "fremont": {LatLon{37.548, -121.989}, "Fremont", "US"},
	"kcm": {LatLon{39.100, -94.578}, "Kansas City", "US"}, "kansascity": {LatLon{39.100, -94.578}, "Kansas City", "US"},
	"tor": {LatLon{43.653, -79.383}, "Toronto", "CA"}, "mtl": {LatLon{45.502, -73.567}, "Montreal", "CA"},
	"wdc": {LatLon{38.907, -77.037}, "Washington", "US"}, "washington": {LatLon{38.907, -77.037}, "Washington", "US"},
}

// three-letter airport codes that are much more often networking words
var notPlaces = map[string]bool{
	"net": true, "com": true, "org": true, "edu": true, "gov": true, "agg": true, "bbr": true, "cor": true,
	"rtr": true, "gin": true, "ntt": true, "bdr": true, "dsl": true, "cpe": true, "dyn": true, "res": true,
	"ptr": true, "pop": true, "lag": true, "eth": true, "ten": true, "hun": true, "one": true, "ipv": true,
	"gig": true, "pos": true, "atm": true, "srv": true, "ixp": true, "per": true, "acc": true, "dis": true,
	"mpr": true, "ear": true, "car": true, "ccr": true, "bun": true, "isp": true, "msn": true, "wan": true,
	"lan": true, "nat": true, "cgn": true, "cdn": true, "aws": true, "gcp": true, "static": true,
	// facebook's switches (aggregation, pod, spine, fabric, rack...) and microsoft's
	// border routers
	"asw": true, "psw": true, "ssw": true, "fsw": true, "rsw": true, "msw": true, "csw": true, "esw": true,
	"ibr": true,
}

// a place a router's name points at, and the code that gave it away
func hintFromName(ptr string) (hintPlace, string, bool) {
	labels := strings.Split(strings.ToLower(ptr), ".")
	// the domain at the end is the carrier's, never a place
	if len(labels) > 2 {
		labels = labels[:len(labels)-2]
	}
	// a place is usually a part of the name on its own - sea01, ash0, washington111.
	// codes inside a part with dashes come second, and only beside something with a
	// number in it (cr6-scl) - so a company name like phoenix-nap stays a name. in
	// there, a code with its number (sea5) beats a bare one (shv-01-sea5)
	var whole, numbered, bare []string
	for _, l := range labels {
		toks := strings.FieldsFunc(l, func(r rune) bool { return r == '-' || r == '_' })
		if len(toks) == 1 {
			whole = append(whole, toks[0])
		} else if slices.ContainsFunc(toks, hasDigit) {
			for _, tok := range toks {
				if hasDigit(tok) {
					numbered = append(numbered, tok)
				} else {
					bare = append(bare, tok)
				}
			}
		}
	}
	for _, tok := range slices.Concat(whole, numbered, bare) {
		if p, code, ok := placeOfCode(tok); ok {
			return p, code, true
		}
	}
	return hintPlace{}, "", false
}

func placeOfCode(tok string) (hintPlace, string, bool) {
	table := airports()
	// codes come with a number stuck on the end - sea01, lon13, lsanca07, frankfurt1
	code := strings.TrimRight(tok, "0123456789")
	if len(code) < 3 || notPlaces[code] {
		return hintPlace{}, "", false
	}
	// 3 letters is an airport/metro code, 6 a CLLI prefix, longer a city name
	if p, ok := table[code]; ok && (len(code) == 3 || len(code) >= 6) {
		return p, code, true
	}
	if len(code) > 6 {
		if p, ok := table[code[:6]]; ok {
			return p, code[:6], true
		}
	}
	return hintPlace{}, "", false
}

func hasDigit(s string) bool { return strings.ContainsAny(s, "0123456789") }
