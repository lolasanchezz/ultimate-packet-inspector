#pragma once
#include <stdint.h>

#define NSTAT_ADDR_LEN 46 // INET6_ADDRSTRLEN
#define NSTAT_NAME_LEN 64

enum nstat_event_kind { NSTAT_FLOW = 1, NSTAT_REMOVED = 2, NSTAT_STATS = 3 };
enum nstat_proto { NSTAT_UDP = 0, NSTAT_TCP = 1 }; // same values as socket_type

// one flow being added/changed, going away (then only id is set), or new
// stats for it (then only id + rttMs are set)
struct nstat_event {
  int kind;
  uint64_t id;
  int pid;
  int proto;
  char processName[NSTAT_NAME_LEN];
  char localAddr[NSTAT_ADDR_LEN];
  uint16_t localPort;
  char remoteAddr[NSTAT_ADDR_LEN];
  uint16_t remotePort;
  int listening; // a tcp socket waiting for connections
  double rttMs;  // average round trip time, tcp only
};

// loads the framework and starts watching every tcp/udp flow. returns 0 on
// success, or fills err and returns -1. only the first call does anything
int nstat_start(char *err, int errLen);

// blocks until the next flow event
void nstat_next(struct nstat_event *ev);
