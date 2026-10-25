package enrich

import "math"

// light in fiber covers about 200km per millisecond (2/3 of c), so a round trip
// of r ms can't have gone further than r/2 * 200 = r * 100 km. real routes are
// longer than great circles and routers add delay, so this is a hard upper
// bound on distance - never an estimate of it
const kmPerRTTms = 100

// geo-ip for our own public address can be off by a city or two
const homeSlackKm = 150

const earthKm = 6371

// MaxKm is the furthest something answering in rttMs can physically be
func MaxKm(rttMs float64) float64 { return rttMs * kmPerRTTms }

func DistanceKm(a, b LatLon) float64 {
	φ1, φ2 := rad(a.Lat), rad(b.Lat)
	dφ, dλ := φ2-φ1, rad(b.Lon-a.Lon)
	h := math.Sin(dφ/2)*math.Sin(dφ/2) + math.Cos(φ1)*math.Cos(φ2)*math.Sin(dλ/2)*math.Sin(dλ/2)
	return 2 * earthKm * math.Asin(math.Min(1, math.Sqrt(h)))
}

// Possible is whether something at p could have answered home in rttMs. false
// means the geo-ip location is wrong - usually anycast, where one address is
// served from hundreds of places and the database only knows the head office
func Possible(home, p LatLon, rttMs float64) bool {
	return rttMs <= 0 || DistanceKm(home, p) <= MaxKm(rttMs)+homeSlackKm
}

// Toward is the point km along the great circle from a to b
func Toward(a, b LatLon, km float64) LatLon {
	total := DistanceKm(a, b)
	if total == 0 || km >= total {
		return b
	}
	δ := total / earthKm
	f := km / total
	φ1, λ1, φ2, λ2 := rad(a.Lat), rad(a.Lon), rad(b.Lat), rad(b.Lon)
	sa, sb := math.Sin((1-f)*δ)/math.Sin(δ), math.Sin(f*δ)/math.Sin(δ)
	x := sa*math.Cos(φ1)*math.Cos(λ1) + sb*math.Cos(φ2)*math.Cos(λ2)
	y := sa*math.Cos(φ1)*math.Sin(λ1) + sb*math.Cos(φ2)*math.Sin(λ2)
	z := sa*math.Sin(φ1) + sb*math.Sin(φ2)
	return LatLon{Lat: deg(math.Atan2(z, math.Hypot(x, y))), Lon: deg(math.Atan2(y, x))}
}

func rad(d float64) float64 { return d * math.Pi / 180 }
func deg(r float64) float64 { return r * 180 / math.Pi }
