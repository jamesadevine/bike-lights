
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
| Light board / rear controller | Toggle left indicator | Toggle right indicator | Toggle hazards |
| Cabin controller | Next front mode/color | Next brightness | Off / restore previous selection |

Rear indication is mutually exclusive and starts illuminated. Selecting a turn
cancels hazards; toggling hazards clears turn selections. Hazards flash the outer
quarters only; automatic braking and the rear tail light continue in the center.
The rear decorative/demo modes and forced-braking gesture have been removed.

The cabin mode cycle is white, warm white, red, green, blue, rainbow, off, then
white. Brightness cycles through approximately 25%, 50%, 75%, and 100%.
The off/restore button preserves color/effect and brightness, including across
cabin-controller restarts. Brightness changes while off do not turn the front on.
Front mode, brightness, and power are independent of rear indication, hazards,
braking, and night/day state.

The rear startup sweep and red brightness ramp are nonblocking. A local button
or rear-controller command cancels them; cabin changes do not. Front lighting
starts independently without waiting for the rear animation. Pixel output is
sent only when colors change, reducing radio receive gaps during NeoPixel output.

### Automatic braking

Mount the micro:bit vertically, with its LED face pointing in the direction of
travel. The [MakeCode acceleration documentation](https://makecode.microbit.org/reference/input/acceleration)
identifies Z as perpendicular to the board and reports negative Z with the LED
face upward. For the face-forward mounting, braking produces a positive Z change.
The firmware samples `Dimension.Z`, not unsigned acceleration strength.

Keep the bike stationary in its mounted orientation for at least one second
after power-on. Fifty samples establish a fixed gravity/installation baseline;
calibration is retried if the sample spread exceeds 80 mg. While calibration is
pending, night lights and indicators still work, but automatic braking is off.
The serial console reports the calibrated Z baseline and brake transitions.

A low-pass-filtered positive delta of 120 mg enables braking; falling below 50 mg
releases it. Full-brightness red takes precedence over dim night red. The default
thresholds in `main.ts` need a mounted bench check: verify braking produces
positive Z and acceleration produces negative Z, then check the trigger/release
thresholds. Calibration and synthetic tests do not validate real braking.
Pitch changes, slopes, and vibration can still affect an accelerometer-only
detector; do not treat it as a substitute for required bicycle lighting.

## Three-board radio protocol

**Flash all apps together.** Protocol version 2 is incompatible with version 1
and the old number/toggle protocol. Use one light board, one rear controller,
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

Packets are fixed 18-byte buffers; multibyte fields are little-endian:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Protocol version (2) |
| 1 | 1 | Rear command (1), cabin command (2), rear status (3), cabin status (4) |
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
(bit 12), right-on (bit 13), and brake-on (bit 14).
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
