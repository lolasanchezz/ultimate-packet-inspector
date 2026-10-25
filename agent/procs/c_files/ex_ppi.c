
#include <arpa/inet.h>
#include <libproc.h>
#include <netinet/in.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/_types/_pid_t.h>
#include <sys/proc_info.h>
#include <unistd.h>

#include "customTypes.h"

void filterSockets(enum filter_listening listening_filter,
                   enum filter_local local_filter,
                   struct socketInfo *socketData, int *socketNum);

struct proc_fdinfo *getFDs(pid_t pid, int *amtfds) {
  // get buffer size for file descriptors
  int bufferSize = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (bufferSize <= 0) {
    return NULL;
  }

  // reserve memory
  struct proc_fdinfo *fdInfo = (struct proc_fdinfo *)malloc(bufferSize);
  if (fdInfo == NULL) {
    perror("malloc");
    return NULL;
  }

  // read file descriptors
  int bytesRead = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fdInfo, bufferSize);
  if (bytesRead <= 0) {
    free(fdInfo);
    return NULL;
  }

  // optional: print sockets
  for (int i = 0; i < (bytesRead / PROC_PIDLISTFD_SIZE); i++) {
    if (fdInfo[i].proc_fdtype == PROX_FDTYPE_SOCKET) {
      // printf("PID %d has socket FD %d\n", pid, fdInfo[i].proc_fd);
    }
  }
  *amtfds = bytesRead / PROC_PIDLISTFD_SIZE;
  return fdInfo;
}

pid_t *getPids(int *amtPids) {
  int pidCount = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (pidCount <= 0) {
    perror("proc_listpids (count)");
    return NULL;
  }

  unsigned long pidsBufSize = sizeof(pid_t) * (unsigned long)pidCount;
  pid_t *pids = (pid_t *)malloc(pidsBufSize);
  if (!pids) {
    perror("malloc");
    return NULL;
  }

  int bytesUsed = proc_listpids(PROC_ALL_PIDS, 0, pids, (int)pidsBufSize);
  if (bytesUsed <= 0) {
    perror("proc_listpids (data)");
    free(pids);
    return NULL;
  }

  int numPids = bytesUsed / sizeof(pid_t);
  int newArrSize = 0;

  for (int i = 0; i < numPids; i++) {
    if (pids[i] != 0)
      newArrSize++;
  }

  pid_t *nonEmptyPids = (pid_t *)malloc(newArrSize * sizeof(pid_t));
  int arrTracker = 0;
  for (int i = 0; i < numPids; i++) {
    if (pids[i] != 0) {
      nonEmptyPids[arrTracker++] = pids[i];
    }
  }

  *amtPids = newArrSize;
  free(pids);
  return nonEmptyPids;
}

int getSocketData(pid_t pid, int fd, struct socket_fdinfo *socketInfo) {
  int bytesRead = proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO,
                                 socketInfo, sizeof(struct socket_fdinfo));
  return bytesRead;
}

void convAddrIpv4(in_addr_t addr, char *ipStr) {
  struct in_addr address;
  address.s_addr = addr;
  inet_ntop(AF_INET, &address, ipStr, INET_ADDRSTRLEN);
}

void convAddrIpv6(const uint8_t addr[16], char *ipStr) {
  struct in6_addr address;
  memcpy(&address, addr, sizeof(address));
  // the kernel tucks the interface index into bytes 2-3 of link-local addresses
  // (fe80:c::...) - clear it so it reads like the address on the wire
  if (IN6_IS_ADDR_LINKLOCAL(&address) || IN6_IS_ADDR_MC_LINKLOCAL(&address)) {
    address.s6_addr[2] = 0;
    address.s6_addr[3] = 0;
  }
  inet_ntop(AF_INET6, &address, ipStr, INET6_ADDRSTRLEN);
}

struct socketinfo_andpid {
  pid_t pid;
  int fd;
  struct socket_fdinfo socketinfo;
};

void pidsSocketsCountInternal(int *numSockets, int *pidAmt,
                              pid_t *allPidsArrPtr) {

  int socketNum = 0;
  for (int i = 0; i < *pidAmt; i++) {
    int amtFds = 0;
    struct proc_fdinfo *fdinfo = getFDs(allPidsArrPtr[i], &amtFds);
    // checking for sockets!
    for (int j = 0; j < amtFds; j++) {
      if (fdinfo[j].proc_fdtype == PROX_FDTYPE_SOCKET) {
        socketNum++;
      }
    }
    free(fdinfo);
  }
  *numSockets = socketNum;
}

void socketCount(int *numSocketsPtr) {
  int amtPids = 0;
  pid_t *allPidsArr = getPids(&amtPids);

  pidsSocketsCountInternal(numSocketsPtr, &amtPids, allPidsArr);
  free(allPidsArr);
}

void descSocket(struct socketInfo *info,
                struct socketinfo_andpid *socket_info) {
  info->creationTime = socket_info->socketinfo.psi.soi_stat.vst_birthtime;
  info->local = 0;
  info->pid = socket_info->pid;
  proc_name(socket_info->pid, info->processName, sizeof(processName_t));
  info->processName[31] = '\0';
  /* Initialize destIPAddr safely */
  strcpy(info->destIPAddr, "0");
  /* TCP / UDP discrimination */
  if (socket_info->socketinfo.psi.soi_kind == SOCKINFO_IN) {

    info->socket_type = UDP;
    info->sourcePort =
        ntohs(socket_info->socketinfo.psi.soi_proto.pri_in.insi_lport);
    info->destPort =
        ntohs(socket_info->socketinfo.psi.soi_proto.pri_in.insi_fport);

    /* Unconnected or listening */
    if (info->destPort == 0) {
      info->listening = 1;
      return;
    }

    if (socket_info->socketinfo.psi.soi_proto.pri_in.insi_vflag & INI_IPV4) {
      info->listening = 0;
      info->connection_type = IPV4;

      char ipStr[INET_ADDRSTRLEN];
      convAddrIpv4(socket_info->socketinfo.psi.soi_proto.pri_in.insi_faddr
                       .ina_46.i46a_addr4.s_addr,
                   ipStr);

      strlcpy(info->destIPAddr, ipStr,
              sizeof(info->destIPAddr)); // local detection
      struct in_addr v4;
      if (inet_pton(AF_INET, info->destIPAddr, &v4) == 1) {
        if ((ntohl(v4.s_addr) & 0xff000000) == 0x7f000000) {
          info->local = 1;
          return;
        }
      }

    } else if (socket_info->socketinfo.psi.soi_proto.pri_in.insi_vflag &
               INI_IPV6) {

      info->listening = 0;
      info->connection_type = IPV6;

      char ipStr[INET6_ADDRSTRLEN];
      convAddrIpv6(socket_info->socketinfo.psi.soi_proto.pri_in.insi_faddr.ina_6
                       .__u6_addr.__u6_addr8,
                   ipStr);

      strlcpy(info->destIPAddr, ipStr,
              sizeof(info->destIPAddr)); // local detection
      struct in6_addr v6;
      if (inet_pton(AF_INET6, info->destIPAddr, &v6) == 1) {
        if (IN6_IS_ADDR_LOOPBACK(&v6)) {
          info->local = 1;
          return;
        }
      }
    }

  } else if (socket_info->socketinfo.psi.soi_kind == SOCKINFO_TCP) {

    info->socket_type = TCP;
    info->sourcePort = ntohs(
        socket_info->socketinfo.psi.soi_proto.pri_tcp.tcpsi_ini.insi_lport);
    info->destPort = ntohs(
        socket_info->socketinfo.psi.soi_proto.pri_tcp.tcpsi_ini.insi_fport);

    /* LISTEN sockets */
    if (info->destPort == 0) {
      info->listening = 1;
      return;
    }

    if (socket_info->socketinfo.psi.soi_proto.pri_tcp.tcpsi_ini.insi_vflag &
        INI_IPV4) {

      info->listening = 0;
      info->connection_type = IPV4;

      char ipStr[INET_ADDRSTRLEN];
      convAddrIpv4(socket_info->socketinfo.psi.soi_proto.pri_tcp.tcpsi_ini
                       .insi_faddr.ina_46.i46a_addr4.s_addr,
                   ipStr);

      strlcpy(info->destIPAddr, ipStr,
              sizeof(info->destIPAddr)); // local detection
      // local detection
      struct in_addr v4;
      if (inet_pton(AF_INET, info->destIPAddr, &v4) == 1) {
        if ((ntohl(v4.s_addr) & 0xff000000) == 0x7f000000) {
          info->local = 1;
          return;
        }
      }

    } else if (socket_info->socketinfo.psi.soi_proto.pri_tcp.tcpsi_ini
                   .insi_vflag & INI_IPV6) {

      info->listening = 0;
      info->connection_type = IPV6;

      char ipStr[INET6_ADDRSTRLEN];
      convAddrIpv6(socket_info->socketinfo.psi.soi_proto.pri_tcp.tcpsi_ini
                       .insi_faddr.ina_6.__u6_addr.__u6_addr8,
                   ipStr);

      strlcpy(info->destIPAddr, ipStr,
              sizeof(info->destIPAddr)); // local detection
      struct in6_addr v6;
      if (inet_pton(AF_INET6, info->destIPAddr, &v6) == 1) {
        if (IN6_IS_ADDR_LOOPBACK(&v6)) {
          info->local = 1;
          return;
        }
      }
    }
  }
}

// fills goSocketData with up to capacity sockets, and sets *socketNum to how many
// were written. sockets can open between socketCount and this, so it never trusts
// the count - anything past capacity is skipped until the next scan
void goSocketStructs(void *goSocketData, int capacity, int *socketNum) {
  struct socketInfo *socketData = (struct socketInfo *)goSocketData;
  int written = 0;

  int amtPids = 0;
  pid_t *allPidsArr = getPids(&amtPids);

  for (int i = 0; i < amtPids && written < capacity; i++) {
    int amtFds = 0;
    struct proc_fdinfo *fdinfo = getFDs(allPidsArr[i], &amtFds);
    for (int j = 0; j < amtFds && written < capacity; j++) {
      if (fdinfo[j].proc_fdtype != PROX_FDTYPE_SOCKET) {
        continue;
      }
      struct socketinfo_andpid socket;
      socket.pid = allPidsArr[i];
      socket.fd = fdinfo[j].proc_fd;
      int bytesRead = getSocketData(socket.pid, socket.fd, &socket.socketinfo);
      // the socket closed since we listed it - nothing valid to read
      if (bytesRead < (int)sizeof(struct socket_fdinfo)) {
        continue;
      }
      memset(&socketData[written], 0, sizeof(struct socketInfo));
      descSocket(&socketData[written], &socket);
      written++;
    }
    free(fdinfo);
  }
  free(allPidsArr);

  *socketNum = written;
  // filterSockets(NO_LISTEN, BOTH_LOCAL_STATES, socketData, socketNum);
}

void removeElement(struct socketInfo *socketArr, int *size, int index) {
  socketArr[index] = socketArr[*size - 1];
  (*size)--;
}

// sorts sockets
void filterSockets(enum filter_listening listening_filter,
                   enum filter_local local_filter,
                   struct socketInfo *socketData, int *socketNum) {

  int write = 0;
  for (int read = 0; read < *socketNum; read++) {
    int keep = 1;
    if (local_filter != BOTH_LOCAL_STATES &&
        socketData[read].local != local_filter) {
      keep = 0;
    } else if (listening_filter != BOTH_LISTEN_STATES &&
               socketData[read].listening != listening_filter) {
      keep = 0;
    }
    if (keep) {
      if (write != read) {
        //    printf("listening = %d\n", socketData[read].listening);
        socketData[write] = socketData[read];
      }
      write++;
    }
  }
  // printf("%d", write);
  *socketNum = write;
  return;
}
