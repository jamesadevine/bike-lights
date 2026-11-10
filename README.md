
> Open this page at [https://jamesadevine.github.io/bike-lights/](https://jamesadevine.github.io/bike-lights/)

## Operation

This micro:bit drives two 96-pixel arches, not left/right strips:

| Pin | Arch | Pixel layout |
| --- | --- | --- |
| P0 | Front, interior | All 96 pixels use the selected cabin mode |
| P1 | Rear | 0-23 left indicator; 24-71 brake/tail; 72-95 right indicator |

Rear pixel 0 is at the rider's left end, looking forward. The arch apex is around
pixels 47-48, within the brake/tail region. Pixel ranges do not overlap.

The light board works without either controller. It starts with automatic
braking, dim red rear night lighting, and steady white front interior lighting
at approximately 25% brightness. Starting, stopping, or losing either controller
never reboots or stops it. Last settings are retained until changed or the light
board restarts; settings are not persisted across light-board power loss.

| Device | A | B | A+B |
| --- | --- | --- | --- |
| Rear (handlebar) controller | Toggle left indicator | Toggle right indicator | Toggle hazards; hold 3 s to recalibrate braking |
| Light board | None | None | Toggle hazards; hold 3 s to toggle colour cycle |
| Cabin controller | Next front mode/color | Next brightness | Off / restore previous selection |

Rear indication is mutually exclusive and starts illuminated. Selecting a turn
cancels hazards; toggling hazards clears turn selections. Hazards flash the outer
quarters only; automatic braking and the rear tail light continue in the center.
The rear decorative modes and forced-braking gesture have been removed; the only
remaining test pattern is the light-board colour cycle below.

The cabin mode cycle is white, warm white, red, green, blue, rainbow, off, then
white. Brightness cycles through approximately 25%, 50%, 75%, and 100%.
The off/restore button preserves color/effect and brightness, including across
cabin-controller restarts. Brightness changes while off do not turn the front on.
Front mode, brightness, and power are independent of rear indication, hazards,
braking, and night/day state.

The rear startup sweep and red brightness ramp are nonblocking. A local A+B action
or rear-controller command cancels them; cabin changes do not. Front lighting
starts independently without waiting for the rear animation. Pixel output is
sent only when colors change, reducing radio receive gaps during NeoPixel output.

### Light-board display

The light board's LED display shows one character for its current state,
rewritten only when the state changes:

| Display | State |
| --- | --- |
| `S` | Calibrating: keep the mounted bike stationary |
| `L` | Learning forwards: waiting for a straight forward pull-away |
| `R` | Ready: automatic braking active, not currently braking |
| `B` | Braking detected |
| `C` | Colour-cycle test mode (takes precedence over the others) |

Indicators and hazards are not shown here; the handlebar controller displays them.

### Colour-cycle test mode

**On the light board itself**, hold A+B together for three seconds to toggle the
colour cycle. Both strips, all 192 pixels, show red, green, blue, then white at
50% brightness, advancing every second and starting at red on entry. Releasing
after the hold does not toggle hazards; shorter A+B presses still toggle hazards.
The handlebar controller's A+B hold remains brake recalibration and cannot
toggle this mode. No radio protocol change is involved.

**The cycle owns both strips:** braking, indicators, hazards, and tail lighting
are not shown until it is turned off. Do not use it while riding. Brake detection,
calibration, and both controllers' commands keep running; settings changed meanwhile
apply on exit, and indicators restart illuminated. Status sent while it is active
reports no rendered indicator or brake output. The mode cancels the startup
animation and is not retained across a light-board restart.

Half-brightness white across 192 pixels can draw several amps; ensure the strip
supply and wiring can handle it before using the test.

### Automatic braking

Rigidly mount the micro:bit at any fixed angle; its LED face no longer needs to
point forwards. `AccelerationMapper` in `acceleration.ts` reads all three axes and
supplies signed longitudinal acceleration in mg to `BrakeSensor`. Positive output
means braking; negative output means forward acceleration.

Calibration has three states, reported in the serial console:

1. **Stationary:** keep the mounted bike upright and stationary after power-on.
   Fifty samples establish a fixed gravity/installation baseline (nominally one
   second, longer when the main loop is busy). Calibration retries if any axis
   varies by more than 80 mg or baseline magnitude is outside 800-1200 mg.
2. **Direction learning:** the first qualifying pull-away is assumed to be
   forward. Horizontal acceleration must remain at least 60 mg for 600 ms, with
   direction alignment of at least 0.95 to its running average. Strong vertical
   motion, weak samples, inconsistent direction, or sample gaps over 100 ms
   restart the candidate. A constant cruising speed provides no direction signal.
3. **Ready:** the learned axis is locked until reset. Acceleration relative to
   the startup baseline is projected onto that axis; subsequent braking cannot
   reverse the learned direction.

The first qualifying movement must be a straight forward departure, not carrying
the bike, wheeling backwards, or immediately turning. Stationary readings cannot
prove that the bike is still, and consistent motion can be misclassified. These
are heuristic checks, not a guarantee of correct calibration. Weak or interrupted
departures leave learning pending.

On the **handlebar `bike-light-controller`**, hold A+B together for three seconds
to reset the baseline, learned direction, and brake filter. Keep the bike
stationary during and after the reset, then pull away forwards again. This leaves
lighting settings unchanged and does not toggle hazards on release. The command
is acknowledged and retries are idempotent. A short A+B on the light board still
only toggles hazards; holding it there toggles the colour-cycle test instead of
recalibrating. Power-cycling the light board also resets calibration;
restarting either remote controller does not. Recalibrate after remounting or an
incorrectly learned departure.

While calibration is incomplete, automatic braking is off; tail lighting and
indicators continue. The handlebar display shows acknowledged `C` when no
indicator or hazards are selected, clearing once ready. The startup animation
does not signal calibration readiness and can temporarily override brake output.

A low-pass-filtered deceleration of at least 120 mg enables braking; 50 mg or below
releases it. Full-brightness red takes precedence over dim night red. Gentle or
brief braking may not trigger, and filter latency depends on preceding motion.
The thresholds in `main.ts` and learning thresholds in `acceleration.ts` require a
mounted bench check. Pitch changes, slopes, and vibration remain limitations of
an accelerometer-only detector; arbitrary mounting support does not compensate
for changes in orientation after calibration. Calibration and synthetic tests
do not validate real braking; do not treat this as a substitute for required
bicycle lighting.

## Three-board radio protocol

**Flash all apps together.** Protocol version 3 is incompatible with earlier
firmware. Use one light board, one rear controller,
and one cabin controller per radio group (default 99 in `protocol.ts`).
Messages are not authenticated.

The rear controller sends only rear mode, indicator, and night/day settings.
The cabin controller sends only front mode, brightness, and power. The light
board rejects commands containing bits outside their scope and merges valid
commands without overwriting the other scope. Each scope has its own inbox,
controller session, command sequence, retired-session tracking, and acknowledgement.
The two controllers cannot retire each other's sessions or acknowledge each
other's requests.

Sequence numbers, per-boot session IDs, and the addressed light session make
retries idempotent and reject stale commands. The light board owns state changes
and rendering in its main loop. Receive callbacks only validate and hand off
packets. Controller restarts adopt existing settings rather than issuing resets.

Each status contains the full desired settings and actual rear blink/brake state,
but acknowledges only its designated controller scope. Status is sent on changes,
on duplicate commands, and approximately every 250 ms per scope. At most one
status packet is sent per main-loop iteration, alternating scopes when both are
due. Missed mode announcements cannot permanently desynchronize a controller;
status revisions reject out-of-order snapshots.

Each controller retries its latest scoped desired state up to eight times at
randomized 100-180 ms intervals. It displays `!` after retry exhaustion or 1.5 s
without status. Lighting continues independently. A new button action starts a
new retry budget; reconnecting after an outage or detecting a light-board
restart also permits retrying a pending request. rapid inputs coalesce into the latest desired state. A failed request is not shown
as successful.

Recalibration uses rear-scoped packet type 5, carrying the complete desired rear
state with the ordinary rear session and sequence. The light board applies the
reset only when that sequence is accepted, so duplicate or stale packets cannot
reset it again. The handlebar controller keeps that transaction unchanged until
acknowledged; subsequent inputs wait in the queue. After retry exhaustion, it
reports failure and releases the queue rather than blocking normal controls.

Packets are fixed 18-byte buffers; multibyte fields are little-endian:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Protocol version (3) |
| 1 | 1 | Rear command (1), cabin command (2), rear status (3), cabin status (4), recalibrate (5) |
| 2 | 4 | Light-board boot session |
| 6 | 4 | Scope's controller boot session (0 before first command) |
| 10 | 4 | Scope's command sequence (0 before first command) |
| 14 | 2 | State |
| 16 | 2 | Status revision; commands use 0 |

State bits 0-2 hold the rear mode (1 = hazards, 4 = automatic), bit 3 requests
left indication, bit 4 requests right indication, and bit 5 enables rear night
lighting. Bits 6-8 select the stored front mode (0-5: white through rainbow),
bits 9-10 select front brightness (0-3), and bit 11 turns the front off without
discarding its selection. Status additionally carries rendered rear left-on
(bit 12), right-on (bit 13), brake-on (bit 14), and brake-calibration-ready
(bit 15). Readiness is status-only and is never part of desired lighting settings.
All three `protocol.ts` copies must remain identical; both controllers also carry
identical `client.ts` transport code. Integration tests enforce this.

## Local checks

With the installed MakeCode CLI, run `mkc build --java-script` in each app directory
(`make check`). `mkc.json` selects the stable micro:bit editor rather than the CLI's
beta default. This checks MakeCode types and generates simulator JavaScript; it
does not produce or validate a native device image.

With Node.js 22.18 or later, run `node --test tests\system.test.cjs` (`make test`).
Keep `bike-light-controller` and `bike-light-cabin-controller` beside this
repository. The dependency-free tests execute all three actual TypeScript apps
with deterministic hardware/radio stubs,
covering lost/duplicate/reordered packets, restarts, bounded failures, standalone
operation, calibration, lighting, and startup. They do not model physical RF
collisions or NeoPixel interrupt timing. No npm installation is needed.

## Use as Extension

This repository can be added as an **extension** in MakeCode.

* open [https://makecode.microbit.org/](https://makecode.microbit.org/)
* click on **New Project**
* click on **Extensions** under the gearwheel menu
* search for **https://github.com/jamesadevine/bike-lights** and import

## Edit this project

To edit this repository in MakeCode.

* open [https://makecode.microbit.org/](https://makecode.microbit.org/)
* click on **Import** then click on **Import URL**
* paste **https://github.com/jamesadevine/bike-lights** and click import

#### Metadata (used for search, rendering)

* for PXT/microbit
<script src="https://makecode.com/gh-pages-embed.js"></script><script>makeCodeRender("{{ site.makecode.home_url }}", "{{ site.github.owner_name }}/{{ site.github.repository_name }}");</script>
