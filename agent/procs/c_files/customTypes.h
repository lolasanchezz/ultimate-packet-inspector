#pragma once
#include <stdlib.h>
#define MAXCOMLEN 16
#define LISTENING_IP_PREFIX "0"
#define LISTENING_IP_PREFIX2 ":"


typedef char ipAddr[46]; // INET6_ADDRSTRLEN - room for a full ipv6 address
typedef uint16_t port;
typedef char processName_t[2 * MAXCOMLEN];
typedef __int32_t pid_t;

enum socket_type { UDP = 0, TCP };

enum connection_type { IPV4 = 1, IPV6 };

enum filter_listening {NO_LISTEN = 0, LISTEN = 1, BOTH_LISTEN_STATES = 2};
enum filter_local {NO_LOCAL = 0, LOCAL = 1, BOTH_LOCAL_STATES = 2};


struct socketInfo {
  pid_t pid;
  processName_t processName;
  enum socket_type socket_type;         // UDP for socket_ln, TCP for socket_tcp
  enum connection_type connection_type; // helps distinguish below ipAddr
  ipAddr destIPAddr;                    // when ipv4, remaining 8 bytes are 0s
  port sourcePort;
  port destPort;
  int local;
  int listening;
  // extra fields for fun
  int creationTime;
};


