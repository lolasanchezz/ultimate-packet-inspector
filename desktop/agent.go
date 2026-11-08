package main

import (
	"context"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"upi/broadcast"
)

// agentProcess is the agent the app started, if it started one
type agentProcess struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
}

// starts the agent, unless one's already broadcasting (`upi install`'s, say).
// it runs with -with-app, so it stops when its stdin closes: when the app quits,
// or crashes, or is killed. it logs where launchd's agent does
func (a *agentProcess) start(ctx context.Context) {
	if running(broadcast.DefaultListen) {
		log.Printf("using the agent already on %s", broadcast.DefaultListen)
		return
	}
	bin := agentBinary()
	home, _ := os.UserHomeDir()
	logPath := filepath.Join(home, "Library", "Logs", "upi.log")
	os.MkdirAll(filepath.Dir(logPath), 0o755)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("agent log: %v", err)
	}
	cmd := exec.Command(bin, "run", "-with-app", "-listen", broadcast.DefaultListen)
	if logFile != nil {
		cmd.Stdout, cmd.Stderr = logFile, logFile
	}
	stdin, err := cmd.StdinPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		log.Printf("couldn't start the agent (%s): %v", bin, err)
		return
	}
	a.cmd, a.stdin = cmd, stdin
	log.Printf("started %s (pid %d) - logs in %s", bin, cmd.Process.Pid, logPath)
	go func() {
		if err := cmd.Wait(); err != nil {
			log.Printf("the agent stopped (%v) - see %s", err, logPath)
		}
		if logFile != nil {
			logFile.Close()
		}
	}()
}

// closing its stdin is enough - it stops on its own, and the app needn't wait
func (a *agentProcess) stop(context.Context) {
	if a.stdin != nil {
		a.stdin.Close()
	}
}

// the one inside the app (scripts/build-app.sh puts it next to the app's own
// binary), or the repo's, or one installed with scripts/install-agent.sh, or
// whatever's on the PATH
func agentBinary() string {
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		exe, _ = filepath.EvalSymlinks(exe)
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "upi"))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "..", "agent", "upi")) // wails dev, from desktop/
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, ".local", "bin", "upi"))
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return "upi"
}

// whether something's already listening there
func running(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}
