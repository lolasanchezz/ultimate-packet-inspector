package enrich

import (
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"

	"github.com/oschwald/maxminddb-golang/v2"
)

// the DB-IP Lite databases (CC BY 4.0), fetched by scripts/fetch-geo.sh
const (
	cityDB = "dbip-city-lite.mmdb"
	asnDB  = "dbip-asn-lite.mmdb"
)

type LatLon struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type Place struct {
	LatLon
	City        string `json:"city"`
	Region      string `json:"region"`
	Country     string `json:"country"`
	CountryCode string `json:"countryCode"`
}

// the autonomous system an address is announced from - who runs that network
type Network struct {
	ASN uint32 `json:"asn"`
	Org string `json:"org"`
}

// Geo looks addresses up offline. either database can be missing - lookups
// against it just find nothing
type Geo struct {
	city, asn *maxminddb.Reader
}

func OpenGeo(dir string) (*Geo, error) {
	g := &Geo{}
	var errs []error
	for name, r := range map[string]**maxminddb.Reader{cityDB: &g.city, asnDB: &g.asn} {
		db, err := maxminddb.Open(filepath.Join(dir, name))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				err = fmt.Errorf("%s isn't in %s - run scripts/fetch-geo.sh", name, dir)
			}
			errs = append(errs, err)
			continue
		}
		*r = db
	}
	return g, errors.Join(errs...)
}

type cityRecord struct {
	City struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"city"`
	Country struct {
		ISOCode string            `maxminddb:"iso_code"`
		Names   map[string]string `maxminddb:"names"`
	} `maxminddb:"country"`
	Subdivisions []struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"subdivisions"`
	Location struct {
		Latitude  float64 `maxminddb:"latitude"`
		Longitude float64 `maxminddb:"longitude"`
	} `maxminddb:"location"`
}

func (g *Geo) Place(a netip.Addr) (Place, bool) {
	if g == nil || g.city == nil {
		return Place{}, false
	}
	var rec cityRecord
	res := g.city.Lookup(a.Unmap())
	if !res.Found() || res.Decode(&rec) != nil {
		return Place{}, false
	}
	p := Place{
		LatLon:      LatLon{Lat: rec.Location.Latitude, Lon: rec.Location.Longitude},
		City:        rec.City.Names["en"],
		Country:     rec.Country.Names["en"],
		CountryCode: rec.Country.ISOCode,
	}
	if len(rec.Subdivisions) > 0 {
		p.Region = rec.Subdivisions[0].Names["en"]
	}
	return p, p.Lat != 0 || p.Lon != 0
}

func (g *Geo) Network(a netip.Addr) (Network, bool) {
	if g == nil || g.asn == nil {
		return Network{}, false
	}
	var rec struct {
		ASN uint32 `maxminddb:"autonomous_system_number"`
		Org string `maxminddb:"autonomous_system_organization"`
	}
	res := g.asn.Lookup(a.Unmap())
	if !res.Found() || res.Decode(&rec) != nil {
		return Network{}, false
	}
	return Network{ASN: rec.ASN, Org: rec.Org}, rec.ASN != 0
}

func (g *Geo) Close() {
	if g == nil {
		return
	}
	for _, r := range []*maxminddb.Reader{g.city, g.asn} {
		if r != nil {
			r.Close()
		}
	}
}
