package upload

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// Client calls the module's reducers over SpacetimeDB's http api. there's no go
// sdk, and the agent only ever writes, so plain http is all it needs
type Client struct {
	Server   string // e.g. https://maincloud.spacetimedb.com
	Database string
	Token    string
	http     http.Client
}

func NewClient(server, database, token string) *Client {
	// go's own resolver, so looking the server up is this process's traffic (and
	// filtered out) rather than mDNSResponder's
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 10 * time.Second, Resolver: &net.Resolver{PreferGo: true}}).DialContext
	return &Client{
		Server:   strings.TrimSuffix(server, "/"),
		Database: database,
		Token:    token,
		http:     http.Client{Timeout: 30 * time.Second, Transport: transport},
	}
}

// NewIdentity asks the server for a fresh identity - the agent's, from then on
func NewIdentity(ctx context.Context, server string) (identity, token string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(server, "/")+"/v1/identity", nil)
	if err != nil {
		return "", "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
		return "", "", fmt.Errorf("new identity: %s: %s", res.Status, body)
	}
	var out struct{ Identity, Token string }
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", "", fmt.Errorf("new identity: %w", err)
	}
	return out.Identity, out.Token, nil
}

// Call runs a reducer. args go over as a json array, in the reducer's order
func (c *Client) Call(ctx context.Context, reducer string, args ...any) error {
	body, err := json.Marshal(args)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("%s/v1/database/%s/call/%s", c.Server, c.Database, reducer)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("%s: %s: %s", reducer, res.Status, bytes.TrimSpace(msg))
	}
	io.Copy(io.Discard, res.Body)
	return nil
}

// Ingest sends one batch
func (c *Client) Ingest(ctx context.Context, b *Batch) error {
	data, err := json.Marshal(b)
	if err != nil {
		return err
	}
	return c.Call(ctx, "ingest", string(data))
}
