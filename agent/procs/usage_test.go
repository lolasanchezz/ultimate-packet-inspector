package procs

import (
	"os"
	"testing"
	"time"
)

func TestReadUsageOfOurselves(t *testing.T) {
	for range 1_000_000 {
		_ = make([]byte, 64) // something to have used some cpu on
	}
	u, ok := ReadUsage(int32(os.Getpid()))
	if !ok || u.CPU <= 0 || u.Footprint == 0 {
		t.Errorf("our own usage: %+v (ok %v)", u, ok)
	}
	if _, ok := ReadUsage(1); ok {
		t.Error("launchd is root's - it shouldn't answer")
	}
}

func TestStartTime(t *testing.T) {
	ours := time.UnixMicro(StartTime(int32(os.Getpid())))
	if time.Since(ours) < 0 || time.Since(ours) > time.Hour {
		t.Errorf("we started at %v?", ours)
	}
	if StartTime(1) == 0 {
		t.Error("launchd's start time should be readable without root")
	}
	if StartTime(-5) != 0 {
		t.Error("no such process")
	}
}
