package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"upi/broadcast"
)

// the agent's settings, in ~/Library/Application Support/upi/config.json if
// it's there (flags beat it). the geo databases live next to it
type config struct {
	Listen   string       `json:"listen"` // where the desktop app connects - a loopback address
	Name     string       `json:"name"`   // what this machine is called in the app
	Iface    string       `json:"iface"`
	Home     *homeSetting `json:"home,omitempty"` // pins where this machine is, instead of looking it up
	Interval float64      `json:"intervalSeconds"`
	MaxPPS   int          `json:"maxPps"`
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
		Listen:   broadcast.DefaultListen,
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
