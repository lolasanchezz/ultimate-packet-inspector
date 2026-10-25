#!/bin/sh
# downloads this month's DB-IP Lite city + ASN databases (CC BY 4.0) to where the
# agent looks for them. DB-IP publishes on the 1st, so last month's is the fallback
set -eu

dir="${1:-$HOME/Library/Application Support/upi}"
mkdir -p "$dir"

fetch() {
	name="$1"
	for month in "$(date +%Y-%m)" "$(date -v-1m +%Y-%m 2>/dev/null || date -d '1 month ago' +%Y-%m)"; do
		url="https://download.db-ip.com/free/dbip-$name-lite-$month.mmdb.gz"
		if curl -sSfL "$url" -o "$dir/dbip-$name-lite.mmdb.gz.part"; then
			gunzip -c "$dir/dbip-$name-lite.mmdb.gz.part" > "$dir/dbip-$name-lite.mmdb.part"
			mv "$dir/dbip-$name-lite.mmdb.part" "$dir/dbip-$name-lite.mmdb"
			rm "$dir/dbip-$name-lite.mmdb.gz.part"
			echo "dbip-$name-lite.mmdb ($month)"
			return 0
		fi
	done
	echo "couldn't download the $name database" >&2
	return 1
}

fetch city
fetch asn
echo "saved to $dir - IP Geolocation by DB-IP (https://db-ip.com)"
