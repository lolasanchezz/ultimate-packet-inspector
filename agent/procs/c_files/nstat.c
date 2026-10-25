// flows from NetworkStatistics, the private framework nettop uses. unlike the
// socket scan it sees network.framework flows (QUIC) and root processes, without
// root. it's private - no headers, and its code lives in the dyld shared cache -
// so it's loaded with dlopen and everything is looked up by name
#include "nstat.h"

#include <CoreFoundation/CoreFoundation.h>
#include <arpa/inet.h>
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <libproc.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define NSTAT_PATH                                                             \
  "/System/Library/PrivateFrameworks/NetworkStatistics.framework/"             \
  "NetworkStatistics"

typedef void *NStatManagerRef;
typedef void *NStatSourceRef;

static NStatManagerRef (*NStatManagerCreate)(CFAllocatorRef, dispatch_queue_t,
                                             void (^)(NStatSourceRef, void *));
static int (*NStatManagerAddAllTCP)(NStatManagerRef);
static int (*NStatManagerAddAllUDP)(NStatManagerRef);
static void (*NStatManagerQueryAllSourcesDescriptions)(NStatManagerRef,
                                                       void (^)(void));
static void (*NStatSourceSetDescriptionBlock)(NStatSourceRef,
                                              void (^)(CFDictionaryRef));
static void (*NStatSourceSetRemovedBlock)(NStatSourceRef, void (^)(void));
static void (*NStatSourceQueryDescription)(NStatSourceRef);
static void (*NStatManagerQueryAllSources)(NStatManagerRef, void (^)(void));
static void (*NStatSourceSetCountsBlock)(NStatSourceRef,
                                         void (^)(CFDictionaryRef));

static CFStringRef kPID, kName, kLocal, kRemote, kProvider, kProviderTCP,
    kProviderUDP, kTCPState, kTCPStateListen, kAvgRTT, kMinRTT;

// events wait here until go reads them. the framework's queue blocks if it's
// full, rather than dropping a flow
#define QUEUE_LEN 1024
static struct nstat_event queue[QUEUE_LEN];
static int queueHead = 0, queueCount = 0;
static pthread_mutex_t queueMu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t queueNotEmpty = PTHREAD_COND_INITIALIZER;
static pthread_cond_t queueNotFull = PTHREAD_COND_INITIALIZER;

static void push(const struct nstat_event *ev) {
  pthread_mutex_lock(&queueMu);
  while (queueCount == QUEUE_LEN) {
    pthread_cond_wait(&queueNotFull, &queueMu);
  }
  queue[(queueHead + queueCount) % QUEUE_LEN] = *ev;
  queueCount++;
  pthread_cond_signal(&queueNotEmpty);
  pthread_mutex_unlock(&queueMu);
}

void nstat_next(struct nstat_event *ev) {
  pthread_mutex_lock(&queueMu);
  while (queueCount == 0) {
    pthread_cond_wait(&queueNotEmpty, &queueMu);
  }
  *ev = queue[queueHead];
  queueHead = (queueHead + 1) % QUEUE_LEN;
  queueCount--;
  pthread_cond_signal(&queueNotFull);
  pthread_mutex_unlock(&queueMu);
}

// addresses come as a struct sockaddr inside a CFData
static void formatAddr(CFDataRef data, char *out, size_t len, uint16_t *port) {
  out[0] = '\0';
  *port = 0;
  if (!data) {
    return;
  }
  CFIndex size = CFDataGetLength(data);
  const struct sockaddr *sa = (const struct sockaddr *)CFDataGetBytePtr(data);
  if (!sa || size < (CFIndex)sizeof(struct sockaddr)) {
    return;
  }

  if (sa->sa_family == AF_INET && size >= (CFIndex)sizeof(struct sockaddr_in)) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)sa;
    inet_ntop(AF_INET, &in->sin_addr, out, len);
    *port = ntohs(in->sin_port);
  } else if (sa->sa_family == AF_INET6 &&
             size >= (CFIndex)sizeof(struct sockaddr_in6)) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)sa;
    struct in6_addr addr = in6->sin6_addr;
    if (IN6_IS_ADDR_V4MAPPED(&addr)) {
      // dual-stack sockets talking ipv4 - the packets on the wire are plain ipv4
      inet_ntop(AF_INET, &addr.s6_addr[12], out, len);
    } else {
      // same as the socket scan - drop the interface index the kernel tucks in
      if (IN6_IS_ADDR_LINKLOCAL(&addr) || IN6_IS_ADDR_MC_LINKLOCAL(&addr)) {
        addr.s6_addr[2] = 0;
        addr.s6_addr[3] = 0;
      }
      inet_ntop(AF_INET6, &addr, out, len);
    }
    *port = ntohs(in6->sin6_port);
  }
}

struct source_state {
  uint64_t id;
  NStatSourceRef src;
  int sent;    // has an event gone out for this flow yet
  int removed; // the flow's gone - ignore any late descriptions
  struct nstat_event last;
  uint64_t createdNs;
  // on the pending list (see below)
  int pending;
  struct source_state *prev, *next;
};

// everything below is only touched on the framework's serial queue
static uint64_t nextID = 0;

// a flow shows up when its socket's created, before connect() fills in the
// remote end - so flows without one get asked about every PENDING_POLL_MS for
// their first PENDING_FOR_MS, letting a new connection's packets match right away
#define PENDING_POLL_MS 50
#define PENDING_FOR_MS 2000
static struct source_state *pendingHead = NULL;

static void pendingAdd(struct source_state *st) {
  if (st->pending) {
    return;
  }
  st->prev = NULL;
  st->next = pendingHead;
  if (pendingHead) {
    pendingHead->prev = st;
  }
  pendingHead = st;
  st->pending = 1;
}

static void pendingRemove(struct source_state *st) {
  if (!st->pending) {
    return;
  }
  if (st->prev) {
    st->prev->next = st->next;
  } else {
    pendingHead = st->next;
  }
  if (st->next) {
    st->next->prev = st->prev;
  }
  st->prev = st->next = NULL;
  st->pending = 0;
}

static void pollPending(void) {
  uint64_t now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
  struct source_state *next;
  for (struct source_state *st = pendingHead; st; st = next) {
    next = st->next;
    if (now - st->createdNs > PENDING_FOR_MS * NSEC_PER_MSEC) {
      pendingRemove(st); // probably a listener - the 1s refresh covers it
      continue;
    }
    NStatSourceQueryDescription(st->src);
  }
}

static void describe(struct source_state *st, CFDictionaryRef d) {
  if (st->removed) {
    return;
  }
  struct nstat_event ev;
  memset(&ev, 0, sizeof ev); // so memcmp below only sees real differences
  ev.kind = NSTAT_FLOW;
  ev.id = st->id;

  CFStringRef provider = CFDictionaryGetValue(d, kProvider);
  if (provider && CFEqual(provider, kProviderTCP)) {
    ev.proto = NSTAT_TCP;
  } else if (provider && CFEqual(provider, kProviderUDP)) {
    ev.proto = NSTAT_UDP;
  } else {
    return;
  }

  CFNumberRef pid = CFDictionaryGetValue(d, kPID);
  if (pid) {
    CFNumberGetValue(pid, kCFNumberIntType, &ev.pid);
  }
  // use the same name as the socket scan so a process doesn't show up twice.
  // a flow's pid doesn't change, so only look it up once
  if (st->sent && st->last.pid == ev.pid) {
    memcpy(ev.processName, st->last.processName, sizeof(ev.processName));
  } else if (ev.pid <= 0 ||
             proc_name(ev.pid, ev.processName, sizeof(ev.processName)) <= 0) {
    CFStringRef name = CFDictionaryGetValue(d, kName);
    if (name) {
      CFStringGetCString(name, ev.processName, sizeof(ev.processName),
                         kCFStringEncodingUTF8);
    }
  }

  formatAddr(CFDictionaryGetValue(d, kLocal), ev.localAddr,
             sizeof(ev.localAddr), &ev.localPort);
  formatAddr(CFDictionaryGetValue(d, kRemote), ev.remoteAddr,
             sizeof(ev.remoteAddr), &ev.remotePort);
  CFStringRef state = CFDictionaryGetValue(d, kTCPState);
  ev.listening = state && CFEqual(state, kTCPStateListen);
  if (ev.remotePort != 0) {
    pendingRemove(st);
  }

  // descriptions get re-sent every second - only pass on real changes.
  // rttMs comes from counted(), so carry it over before comparing
  ev.rttMs = st->last.rttMs;
  if (st->sent && memcmp(&ev, &st->last, sizeof ev) == 0) {
    return;
  }
  st->last = ev;
  st->sent = 1;
  push(&ev);
}

// round trip times come with a flow's counts, not its description (seconds, as
// a double). the minimum where there is one: a busy network (a download, crowded
// wifi) adds queueing to the average, and these go into a speed-of-light check
// that has to be an upper bound on distance. only pass on changes of at least a
// millisecond
static void counted(struct source_state *st, CFDictionaryRef d) {
  if (st->removed || !st->sent || st->last.proto != NSTAT_TCP) {
    return;
  }
  CFNumberRef rtt = kMinRTT ? CFDictionaryGetValue(d, kMinRTT) : NULL;
  double seconds = 0;
  if (!rtt || !CFNumberGetValue(rtt, kCFNumberDoubleType, &seconds) ||
      seconds <= 0) {
    rtt = CFDictionaryGetValue(d, kAvgRTT);
    if (!rtt || !CFNumberGetValue(rtt, kCFNumberDoubleType, &seconds) ||
        seconds <= 0) {
      return;
    }
  }
  double ms = seconds * 1000;
  if (ms - st->last.rttMs < 1 && st->last.rttMs - ms < 1) {
    return;
  }
  st->last.rttMs = ms;

  struct nstat_event ev;
  memset(&ev, 0, sizeof ev);
  ev.kind = NSTAT_STATS;
  ev.id = st->id;
  ev.rttMs = ms;
  push(&ev);
}

static void onSource(NStatSourceRef src, dispatch_queue_t q) {
  struct source_state *st = calloc(1, sizeof *st);
  if (!st) {
    return;
  }
  st->id = ++nextID;
  st->src = src;
  st->createdNs = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
  pendingAdd(st);

  NStatSourceSetDescriptionBlock(src, ^(CFDictionaryRef d) {
    describe(st, d);
  });
  NStatSourceSetCountsBlock(src, ^(CFDictionaryRef d) {
    counted(st, d);
  });
  NStatSourceSetRemovedBlock(src, ^{
    st->removed = 1;
    pendingRemove(st);
    if (st->sent) {
      struct nstat_event ev;
      memset(&ev, 0, sizeof ev);
      ev.kind = NSTAT_REMOVED;
      ev.id = st->id;
      push(&ev);
    }
    // free it later, so a description already queued behind this is harmless
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), q, ^{
      free(st);
    });
  });
  NStatSourceQueryDescription(src);
}

static CFStringRef loadKey(void *h, const char *name) {
  CFStringRef *p = dlsym(h, name);
  return p ? *p : NULL;
}

#define LOAD(fn)                                                               \
  fn = dlsym(h, #fn);                                                          \
  if (!fn) {                                                                   \
    snprintf(err, errLen, "missing %s", #fn);                                  \
    return -1;                                                                 \
  }

int nstat_start(char *err, int errLen) {
  static int started = 0;
  if (started) {
    return 0;
  }

  void *h = dlopen(NSTAT_PATH, RTLD_LAZY);
  if (!h) {
    snprintf(err, errLen, "%s", dlerror());
    return -1;
  }
  LOAD(NStatManagerCreate);
  LOAD(NStatManagerAddAllTCP);
  LOAD(NStatManagerAddAllUDP);
  LOAD(NStatManagerQueryAllSourcesDescriptions);
  LOAD(NStatSourceSetDescriptionBlock);
  LOAD(NStatSourceSetRemovedBlock);
  LOAD(NStatSourceQueryDescription);
  LOAD(NStatManagerQueryAllSources);
  LOAD(NStatSourceSetCountsBlock);

  kPID = loadKey(h, "kNStatSrcKeyPID");
  kName = loadKey(h, "kNStatSrcKeyProcessName");
  kLocal = loadKey(h, "kNStatSrcKeyLocal");
  kRemote = loadKey(h, "kNStatSrcKeyRemote");
  kProvider = loadKey(h, "kNStatSrcKeyProvider");
  kProviderTCP = loadKey(h, "kNStatProviderTCP");
  kProviderUDP = loadKey(h, "kNStatProviderUDP");
  kTCPState = loadKey(h, "kNStatSrcKeyTCPState");
  kTCPStateListen = loadKey(h, "kNStatSrcTCPStateListen");
  kAvgRTT = loadKey(h, "kNStatSrcKeyAvgRTT");
  kMinRTT = loadKey(h, "kNStatSrcKeyMinRTT"); // optional - the average does without
  if (!kPID || !kName || !kLocal || !kRemote || !kProvider || !kProviderTCP ||
      !kProviderUDP || !kTCPState || !kTCPStateListen || !kAvgRTT) {
    snprintf(err, errLen, "missing description keys");
    return -1;
  }

  dispatch_queue_t q = dispatch_queue_create("upi.nstat", DISPATCH_QUEUE_SERIAL);
  NStatManagerRef m = NStatManagerCreate(kCFAllocatorDefault, q,
                                         ^(NStatSourceRef src, void *unused) {
                                           onSource(src, q);
                                         });
  if (!m) {
    snprintf(err, errLen, "NStatManagerCreate failed");
    return -1;
  }
  NStatManagerAddAllTCP(m);
  NStatManagerAddAllUDP(m);

  // a flow's description changes over its life (connecting fills in the
  // remote end), so ask for all of them again every second
  dispatch_source_t timer =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, q);
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC),
                            NSEC_PER_SEC, NSEC_PER_SEC / 10);
  dispatch_source_set_event_handler(timer, ^{
    NStatManagerQueryAllSourcesDescriptions(m, ^{
    });
    NStatManagerQueryAllSources(m, ^{ // counts, for round trip times
    });
  });
  dispatch_resume(timer);

  dispatch_source_t pendingTimer =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, q);
  dispatch_source_set_timer(pendingTimer, DISPATCH_TIME_NOW,
                            PENDING_POLL_MS * NSEC_PER_MSEC, NSEC_PER_MSEC * 5);
  dispatch_source_set_event_handler(pendingTimer, ^{
    pollPending();
  });
  dispatch_resume(pendingTimer);

  started = 1;
  return 0;
}
