# Windows host timer cadence investigation

The room requests a 5 ms timer wake (200 Hz), then drains its fixed-step accumulator.
Selecting High requests 128 simulation steps and 90 snapshots per second. The requested
timer interval is not a guarantee that Windows will deliver every wake at that spacing.

## Local measurements

On the investigation machine (Windows build 22631, Node 24.11.1, libuv 1.51.0), two isolated
three-second `setInterval(..., 5)` runs delivered approximately 64.0-64.25 callbacks/second,
with a 15.57 ms median gap and 16.3-16.6 ms p95. A worker sleeping with `Atomics.wait(..., 5)`
also delivered about 64.2 wakes/second. Moving this timer into a worker alone did not improve
its resolution.

A later five-second diagnostic on the same runtime delivered 90.14 callbacks/second with
an 11.73 ms median and 16.39 ms p95. The changing result further limits any claim of a fixed
machine-wide 64 Hz cap; these short samples reflect the machine's state while each ran.

These are **idle process measurements**, not measured live-room snapshot limits. WebSocket
and WebRTC traffic can wake Node's event loop before its timer timeout. A foreground browser
producing frequent input may therefore change the result. No measurement here establishes
the cause of the friend's across-city ping or proves that every Windows match is capped at
64 snapshots/second.

If an actual 128 Hz room wakes only every 15.6 ms, its accumulator can still simulate roughly
two fixed steps per wake. That does not make those steps evenly timed on the network. The
uncoupled snapshot path emits at most one fresh snapshot per wake, so **under that measured
live condition** a 90 Hz snapshot target would not be delivered. Verify actual room wake and
snapshot rates before applying this explanation to a playtest.

Run the dependency-free diagnostic using the same Node executable as the host:

```powershell
npm.cmd --prefix server run diagnose:timing
npm.cmd --prefix server run diagnose:timing -- --duration-ms 10000 --wake-ms 5
```

It prints requested/observed wake rates, interval percentiles, runtime/OS versions, and CPU
time. It changes no system settings. Run it with the PC otherwise idle and again under normal
gameplay load; it remains a separate process and cannot replace the live server's diagnostics.
CPU figures are approximate because short idle runs can fall below OS CPU accounting resolution.

## What the sources establish

Node explicitly does not promise exact timer callback timing. Its current timer API also
truncates fractional delays; changing `5` to `5.0` cannot improve scheduling.
See [Node's timer documentation](https://github.com/nodejs/node/blob/v24.11.1/doc/api/timers.md).

The installed runtime's [libuv 1.51 Windows event loop](https://github.com/libuv/libuv/blob/v1.51.0/src/win/core.c)
waits in `GetQueuedCompletionStatusEx` with a millisecond timeout. Incoming I/O can end that
wait early. The observed 15.6 ms cadence is consistent with coarse Windows timeout delivery;
this alone does not prove CPU saturation or network delay.

Microsoft documents that `timeBeginPeriod` can improve timeout precision, must be paired with
`timeEndPeriod`, and can affect power consumption. Since Windows 10 version 2004, a process
that has not requested the resolution itself is not guaranteed to benefit from another
process's request. Windows 11 also adds visibility-related qualifications. A separate timer
utility or launcher is therefore not a dependable per-host fix.
See [Microsoft's timeBeginPeriod documentation](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod).

The [libuv changelog](https://github.com/libuv/libuv/blob/v1.53.0/ChangeLog) through 1.53.0 does
not identify a Windows timer-resolution fix, and its
[Windows poll implementation](https://github.com/libuv/libuv/blob/v1.53.0/src/win/core.c)
still uses the same timeout API. An updated supported Node version is worth measuring, but
the reviewed source does not justify promising that a Node upgrade resolves this cadence.

## Practical next step

Capture live wake intervals, achieved snapshot rate, server-loop excess delay, CPU, and the
guest's application/ICE RTT during the same 1v1 and 2v2 scenarios. Keep the Direct/Relay route
recorded. This separates a local scheduling problem from transport and rendering delay.

The implemented latency fixes do not replace the server scheduler. Continuous `setImmediate`
polling would spend CPU that the local game also needs; worker timers did not help this
measurement. If live captures confirm coarse wakes remain a bottleneck, the next contained
engineering experiment is a native, lifecycle-managed high-resolution timer for the Windows
host, with packaging, CPU, shutdown, and foreground/background validation. Windows provides
[high-resolution waitable timers](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createwaitabletimerexw)
for short deadlines. That requires native integration; it should be tested before inclusion
in the downloadable host. No permanent OS tweak is part of this change.
