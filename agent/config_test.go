package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseEnv(t *testing.T) {
	vals := map[string]string{}
	parseEnv(`
# where the database is
UPI_SERVER=https://maincloud.spacetimedb.com
export UPI_DB="lola-upi"
UPI_SITE='https://upi.example'  
UPI_OTHER=thing # a comment
not a line
`, vals)
	want := map[string]string{
		"UPI_SERVER": "https://maincloud.spacetimedb.com",
		"UPI_DB":     "lola-upi",
		"UPI_SITE":   "https://upi.example",
		"UPI_OTHER":  "thing",
	}
	for k, v := range want {
		if vals[k] != v {
			t.Errorf("%s = %q, want %q", k, vals[k], v)
		}
	}
	if len(vals) != len(want) {
		t.Errorf("extra keys: %v", vals)
	}
}

// a .env above the working directory wins over the saved config, the
// environment wins over the .env, and ws:// becomes http:// for the api
func TestApplyEnv(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, ".env"), []byte("UPI_SERVER=ws://127.0.0.1:3000\nUPI_DB=from-file\nUPI_SITE=https://site\n"), 0o644)
	sub := filepath.Join(root, "agent")
	os.Mkdir(sub, 0o755)
	t.Chdir(sub)
	t.Setenv("UPI_DB", "from-env")

	c := config{Server: "https://maincloud.spacetimedb.com", Database: "saved"}
	if from := applyEnv(&c); from != filepath.Join(root, ".env") {
		t.Errorf("read %q", from)
	}
	if c.Server != "http://127.0.0.1:3000" || c.Database != "from-env" || c.Site != "https://site" {
		t.Errorf("config: %+v", c)
	}
}
