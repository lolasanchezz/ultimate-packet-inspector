package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// everything the agent remembers between runs, in
// ~/Library/Application Support/upi/config.json. the geo databases live next to it
type config struct {
	Server   string `json:"server"`   // the SpacetimeDB host
	Database string `json:"database"` // the name the module was published under
	Site     string `json:"site"`     // where the website lives, for pairing links
	Identity string `json:"identity"` // the agent's own identity + token, made on first run
	Token    string `json:"token"`
	// the server the token's from - it's no good anywhere else
	TokenServer string       `json:"tokenServer,omitempty"`
	Name        string       `json:"name"` // what this machine is called on the website
	Iface       string       `json:"iface"`
	Home        *homeSetting `json:"home,omitempty"` // pins where this machine is, instead of looking it up
	Interval    float64      `json:"intervalSeconds"`
	MaxPPS      int          `json:"maxPps"`
}

type homeSetting struct {
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	Place string  `json:"place"`
}

func configDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "upi"), nil
}

func loadConfig() (config, error) {
	host, _ := os.Hostname()
	c := config{
		Server:   "https://maincloud.spacetimedb.com",
		Name:     host,
		Iface:    "en0",
		Interval: 2,
		MaxPPS:   5000,
	}
	dir, err := configDir()
	if err != nil {
		return c, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	return c, json.Unmarshal(data, &c)
}

// where the database is lives in one place for the whole repo: UPI_SERVER, UPI_DB
// and UPI_SITE, in the environment or a .env file (see .env.example). the
// website's build and the module's deploy read the same ones. they beat whatever
// the config last saved, and flags beat them
func applyEnv(c *config) (from string) {
	vals, from := dotenv()
	for _, k := range []string{"UPI_SERVER", "UPI_DB", "UPI_SITE"} {
		if v, ok := os.LookupEnv(k); ok {
			vals[k] = v
		}
	}
	if v := vals["UPI_SERVER"]; v != "" {
		// the website wants ws(s)://, the http api https:// - take either
		if strings.HasPrefix(v, "ws") {
			v = "http" + strings.TrimPrefix(v, "ws")
		}
		c.Server = strings.TrimSuffix(v, "/")
	}
	if v := vals["UPI_DB"]; v != "" {
		c.Database = v
	}
	if v := vals["UPI_SITE"]; v != "" {
		c.Site = v
	}
	return from
}

// the nearest .env above the working directory, or above the binary - so a upi
// built in the repo finds the repo's .env even when launchd starts it from /
func dotenv() (map[string]string, string) {
	vals := map[string]string{}
	var starts []string
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	if exe, err := os.Executable(); err == nil {
		if exe, err = filepath.EvalSymlinks(exe); err == nil {
			starts = append(starts, filepath.Dir(exe))
		}
	}
	for _, dir := range starts {
		for ; ; dir = filepath.Dir(dir) {
			path := filepath.Join(dir, ".env")
			if data, err := os.ReadFile(path); err == nil {
				parseEnv(string(data), vals)
				return vals, path
			}
			if filepath.Dir(dir) == dir {
				break
			}
		}
	}
	return vals, ""
}

// KEY=value lines - comments, blank lines, `export ` and quotes allowed
func parseEnv(data string, into map[string]string) {
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.HasPrefix(k, "#") {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		} else if i := strings.Index(v, " #"); i >= 0 {
			v = strings.TrimSpace(v[:i]) // a comment after an unquoted value
		}
		into[strings.TrimSpace(k)] = v
	}
}

// the token's in here, so only we can read it. it's written to a new file that
// then replaces the old one, so it's never half written, and always ends up 0600
// however the old one was made
func saveConfig(c config) error {
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "config-*.json") // 0600
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once it's been renamed
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, "config.json"))
}
