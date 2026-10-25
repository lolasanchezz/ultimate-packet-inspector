package procs

/*
#include <libproc.h>
#include <sys/resource.h>
#include <mach/mach_time.h>
#include <sys/sysctl.h>

// cpu time comes in mach ticks - nanoseconds on intel, not on apple silicon
static int pid_usage(int pid, uint64_t *cpu, uint64_t *footprint, uint64_t *disk) {
	struct rusage_info_v4 ri;
	if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ri) != 0) return -1;
	static mach_timebase_info_data_t tb;
	if (tb.denom == 0) mach_timebase_info(&tb);
	*cpu = (ri.ri_user_time + ri.ri_system_time) * tb.numer / tb.denom;
	*footprint = ri.ri_phys_footprint;
	*disk = ri.ri_diskio_bytesread + ri.ri_diskio_byteswritten;
	return 0;
}

// anyone can ask when a process started - ps does, without root
static int64_t pid_start_us(int pid) {
	struct kinfo_proc kp;
	size_t len = sizeof kp;
	int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
	if (sysctl(mib, 4, &kp, &len, NULL, 0) != 0 || len == 0) return 0;
	return (int64_t)kp.kp_proc.p_starttime.tv_sec * 1000000 + kp.kp_proc.p_starttime.tv_usec;
}
*/
import "C"
import "time"

// Usage is what a process has cost the machine since it started
type Usage struct {
	CPU       time.Duration // every core's added up
	Footprint uint64        // memory, the way activity monitor counts it
	Disk      uint64        // bytes read + written
}

// ReadUsage asks the kernel what a process has used. it only answers for our own
// user's processes - root's say no
func ReadUsage(pid int32) (Usage, bool) {
	var cpu, mem, disk C.uint64_t
	if C.pid_usage(C.int(pid), &cpu, &mem, &disk) != 0 {
		return Usage{}, false
	}
	return Usage{CPU: time.Duration(cpu), Footprint: uint64(mem), Disk: uint64(disk)}, true
}

// StartTime is when a process started, in µs since the epoch - 0 if there's no
// such process
func StartTime(pid int32) int64 {
	return int64(C.pid_start_us(C.int(pid)))
}
