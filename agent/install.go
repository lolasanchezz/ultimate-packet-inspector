package main

import (
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// a launch agent rather than a daemon - capture works without root for anyone
// in the access_bpf group (Wireshark's ChmodBPF sets that up)
const launchLabel = "com.hackclub.upi"

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array><string>%s</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`

// a path, safe to go in the plist's xml
func xmlText(s string) string {
	var b strings.Builder
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

func plistPath() (string, error) {
	home, err := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchLabel+".plist"), err
}

func install() error {
	if _, err := loadConfig(); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	path, err := plistPath()
	if err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	logPath := filepath.Join(home, "Library", "Logs", "upi.log")
	// neither's there on every account
	for _, dir := range []string{filepath.Dir(path), filepath.Dir(logPath)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	if err := os.WriteFile(path, fmt.Appendf(nil, plist, launchLabel, xmlText(exe), xmlText(logPath), xmlText(logPath)), 0o644); err != nil {
		return err
	}
	domain := "gui/" + strconv.Itoa(os.Getuid())
	exec.Command("launchctl", "bootout", domain+"/"+launchLabel).Run() // an older copy, if there is one
	out, err := exec.Command("launchctl", "bootstrap", domain, path).CombinedOutput()
	if err != nil {
		// the older copy can take a moment to go
		time.Sleep(2 * time.Second)
		out, err = exec.Command("launchctl", "bootstrap", domain, path).CombinedOutput()
	}
	if err != nil {
		return fmt.Errorf("launchctl bootstrap: %v: %s", err, out)
	}
	fmt.Printf("installed - upi runs at login now. logs go to %s\n", logPath)
	return nil
}

func uninstall() error {
	path, err := plistPath()
	if err != nil {
		return err
	}
	exec.Command("launchctl", "bootout", "gui/"+strconv.Itoa(os.Getuid())+"/"+launchLabel).Run()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Println("uninstalled")
	return nil
}
