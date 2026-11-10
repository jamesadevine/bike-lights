const STRIP_LENGTH = 96
const LEFT_INDICATOR_END = Math.floor(STRIP_LENGTH / 4)
const RIGHT_INDICATOR_START = STRIP_LENGTH - LEFT_INDICATOR_END
const NIGHT_BRIGHTNESS = 8
const FRONT_BRIGHTNESS = [64, 128, 192, 255]
const FRONT_COLORS = [0xffffff, 0xffaa55, 0xff0000, 0x00ff00, 0x0000ff]
const FRAME_INTERVAL = 50
const BLINK_INTERVAL = 200
const STATUS_INTERVAL = 250
const BRAKE_THRESHOLD = 120
const BRAKE_RELEASE_THRESHOLD = 50
const COLOR_CYCLE = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff]
const COLOR_CYCLE_INTERVAL = 1000
const COLOR_CYCLE_BRIGHTNESS = 128
const COLOR_CYCLE_HOLD = 3000

class BrakeSensor {
    braking = false
    filtered = 0

    constructor() {
    }

    reset() {
        this.braking = false
        this.filtered = 0
    }

    sample(value: number) {
        this.filtered += (value - this.filtered) / 4
        const was_braking = this.braking
        if (this.filtered >= BRAKE_THRESHOLD)
            this.braking = true
        else if (this.filtered <= BRAKE_RELEASE_THRESHOLD)
            this.braking = false
        if (this.braking != was_braking)
            console.log("Brake " + (this.braking ? "on" : "off") + ", deceleration (mg): " + this.filtered)
    }
}

class LightStrip {
    strip: neopixel.Strip
    pixels: number[]
    dirty = false

    constructor(pin: DigitalPin) {
        this.strip = neopixel.create(pin, STRIP_LENGTH, NeoPixelMode.RGB)
        this.strip.setBrightness(255)
        this.pixels = []
        for (let i = 0; i < STRIP_LENGTH; i++)
            this.pixels.push(-1)
    }

    fill(start: number, end: number, color: number, brightness: number) {
        let scaled = color
        if (brightness < 255) {
            const red = (((color >> 16) & 255) * brightness) >> 8
            const green = (((color >> 8) & 255) * brightness) >> 8
            const blue = ((color & 255) * brightness) >> 8
            scaled = (red << 16) | (green << 8) | blue
        }
        for (let i = start; i < end; i++) {
            if (this.pixels[i] != scaled) {
                this.pixels[i] = scaled
                this.strip.setPixelColor(i, scaled)
                this.dirty = true
            }
        }
    }

    show() {
        if (this.dirty) {
            this.dirty = false
            this.strip.show()
        }
    }
}

class ControllerPeer {
    session = 0
    sequence = 0
    retired: number[]

    constructor() {
        this.retired = []
    }

    accept(session: number, sequence: number): boolean {
        if (this.retired.indexOf(session) >= 0)
            return false
        if (session != this.session) {
            if (this.session != 0) {
                this.retired.push(this.session)
                if (this.retired.length > 8)
                    this.retired.shift()
            }
            this.session = session
            this.sequence = 0
        }
        if (sequence <= this.sequence)
            return false
        this.sequence = sequence
        return true
    }
}

const light_actions: BikeRadio.Action[] = []
const rear_peer = new ControllerPeer()
const cabin_peer = new ControllerPeer()
const lights_session = BikeRadio.session()
const acceleration_mapper = new AccelerationMapper()
const brake_sensor = new BrakeSensor()
const front_strip = new LightStrip(DigitalPin.P0)
const rear_strip = new LightStrip(DigitalPin.P1)
let rear_inbox: Buffer = null
let cabin_inbox: Buffer = null
let desired_state = BikeRadio.Mode.Automatic | BikeRadio.NIGHT
let rendered_state = -1
let status_revision = 0
let status_due = 3
let last_rear_status = input.runningTime()
let last_cabin_status = input.runningTime()
let last_status_domain = BikeRadio.Domain.Cabin
let last_frame = input.runningTime()
let last_sample = input.runningTime()
let mode_started = input.runningTime()
let indicator_started = input.runningTime()
let front_started = input.runningTime()
let startup_started = input.runningTime()
let startup = true
let color_cycle = false
let color_cycle_started = input.runningTime()
let held_buttons = 0
let hold_started = 0
let hold_active = false
let hold_handled = false
let display_label = ""

radio.setGroup(BikeRadio.GROUP)
radio.setTransmitPower(7)
radio.onReceivedBuffer(function (data: Buffer) {
    if (data.length >= 2 && data[0] == BikeRadio.VERSION &&
        data[1] != BikeRadio.PacketType.RearCommand &&
        data[1] != BikeRadio.PacketType.CabinCommand && data[1] != BikeRadio.PacketType.Recalibrate)
        return
    const type = data.length >= 2 ? data[1] : 0
    if ((type != BikeRadio.PacketType.RearCommand && type != BikeRadio.PacketType.CabinCommand &&
        type != BikeRadio.PacketType.Recalibrate) ||
        !BikeRadio.validPacket(data, type)) {
        console.log("Ignoring invalid radio command")
        return
    }
    if (type != BikeRadio.PacketType.CabinCommand)
        rear_inbox = data
    else
        cabin_inbox = data
})

function applyState(state: number, now: number, rear_command: boolean) {
    if (state == desired_state && (!startup || !rear_command))
        return
    if ((state & 7) != (desired_state & 7) || (startup && rear_command))
        mode_started = now
    if ((state & (BikeRadio.LEFT | BikeRadio.RIGHT)) !=
        (desired_state & (BikeRadio.LEFT | BikeRadio.RIGHT)) || (startup && rear_command))
        indicator_started = now
    if ((state & (BikeRadio.FRONT_MODE_MASK | BikeRadio.FRONT_OFF)) !=
        (desired_state & (BikeRadio.FRONT_MODE_MASK | BikeRadio.FRONT_OFF)))
        front_started = now
    desired_state = state
    if (rear_command)
        startup = false
    last_frame = now - FRAME_INTERVAL
    status_due = 3
}

function receiveCommand(data: Buffer, now: number) {
    if (data.getNumber(NumberFormat.UInt32LE, 2) != lights_session)
        return
    const domain = data[1] == BikeRadio.PacketType.CabinCommand ?
        BikeRadio.Domain.Cabin : BikeRadio.Domain.Rear
    const peer = domain == BikeRadio.Domain.Rear ? rear_peer : cabin_peer
    const session = data.getNumber(NumberFormat.UInt32LE, 6)
    const sequence = data.getNumber(NumberFormat.UInt32LE, 10)
    if (peer.accept(session, sequence)) {
        if (data[1] == BikeRadio.PacketType.Recalibrate) {
            acceleration_mapper.reset()
            brake_sensor.reset()
            last_frame = now - FRAME_INTERVAL
        }
        const mask = BikeRadio.domainMask(domain)
        const state = (desired_state & ~mask) | data.getNumber(NumberFormat.UInt16LE, 14)
        applyState(state, now, domain == BikeRadio.Domain.Rear)
    }
    // A duplicate can be a retry after its acknowledgement was lost.
    status_due |= 1 << domain
}

function toggleColorCycle(now: number) {
    color_cycle = !color_cycle
    color_cycle_started = now
    startup = false
    mode_started = now
    indicator_started = now
    last_frame = now - FRAME_INTERVAL
    console.log("Colour cycle " + (color_cycle ? "on" : "off"))
}

// Polled so a long A+B hold can be distinguished from a short hazards press.
// A or B alone does nothing; indicators are selected from the handlebar controller.
function pollButtons(now: number) {
    const pressed = (input.buttonIsPressed(Button.A) ? 1 : 0) |
        (input.buttonIsPressed(Button.B) ? 2 : 0)
    held_buttons |= pressed
    if (pressed == 3) {
        if (!hold_active) {
            hold_started = now
            hold_active = true
        }
        if (!hold_handled && BikeRadio.elapsed(now, hold_started) >= COLOR_CYCLE_HOLD) {
            hold_handled = true
            toggleColorCycle(now)
        }
    } else {
        hold_active = false
    }
    if (pressed == 0 && held_buttons != 0) {
        if (!hold_handled && held_buttons == 3)
            light_actions.push(BikeRadio.Action.Hazards)
        held_buttons = 0
        hold_handled = false
    }
}

function renderStartup(now: number): boolean {
    const elapsed = BikeRadio.elapsed(now, startup_started)
    if (elapsed < 1500) {
        const position = Math.floor(elapsed / 10) % (2 * (STRIP_LENGTH - 1))
        const index = position < STRIP_LENGTH ? position : 2 * (STRIP_LENGTH - 1) - position
        rear_strip.fill(0, STRIP_LENGTH, 0, 255)
        rear_strip.fill(index, index + 1, 0xff0000, 128)
        return true
    }
    const step = Math.floor((elapsed - 1500) / 100)
    const brightness = [0, 16, 32, 64, 128, 255]
    if (step < brightness.length) {
        rear_strip.fill(0, STRIP_LENGTH, 0xff0000, brightness[step])
        return true
    }
    startup = false
    mode_started = now
    indicator_started = now
    return false
}

function renderFront(now: number) {
    const mode = BikeRadio.frontMode(desired_state)
    const brightness = FRONT_BRIGHTNESS[(desired_state & BikeRadio.FRONT_LEVEL_MASK) >> 9]
    if (mode == BikeRadio.FrontMode.Off) {
        front_strip.fill(0, STRIP_LENGTH, 0, 255)
    } else if (mode == BikeRadio.FrontMode.Rainbow) {
        const offset = Math.floor(BikeRadio.elapsed(now, front_started) / BLINK_INTERVAL)
        for (let i = 0; i < STRIP_LENGTH; i++) {
            const color = neopixel.hsl(((i + offset) * 360 / STRIP_LENGTH) % 360, 100, 50)
            front_strip.fill(i, i + 1, color, brightness)
        }
    } else {
        front_strip.fill(0, STRIP_LENGTH, FRONT_COLORS[mode], brightness)
    }
    front_strip.show()
}

function updateRenderedState(state: number) {
    if (acceleration_mapper.state == AccelerationCalibrationState.Ready)
        state |= BikeRadio.BRAKE_READY
    if (state != rendered_state) {
        rendered_state = state
        status_due = 3
    }
}

// One character per state; the display is written only when the state changes.
function updateDisplay() {
    let label = "R"
    if (color_cycle)
        label = "C"
    else if (acceleration_mapper.state == AccelerationCalibrationState.Stationary)
        label = "S"
    else if (acceleration_mapper.state == AccelerationCalibrationState.Direction)
        label = "L"
    else if (brake_sensor.braking)
        label = "B"
    if (label != display_label) {
        display_label = label
        basic.showString(label, 0)
    }
}

function renderColorCycle(now: number) {
    const phase = Math.floor(BikeRadio.elapsed(now, color_cycle_started) / COLOR_CYCLE_INTERVAL)
    const color = COLOR_CYCLE[phase % COLOR_CYCLE.length]
    front_strip.fill(0, STRIP_LENGTH, color, COLOR_CYCLE_BRIGHTNESS)
    rear_strip.fill(0, STRIP_LENGTH, color, COLOR_CYCLE_BRIGHTNESS)
    front_strip.show()
    rear_strip.show()
    // Indicators and braking are not rendered, so status must not report them.
    updateRenderedState(desired_state)
}

function renderLights(now: number) {
    if (color_cycle) {
        renderColorCycle(now)
        return
    }
    let state = desired_state
    renderFront(now)
    if (startup && renderStartup(now)) {
        rear_strip.show()
        return
    }
    const mode = desired_state & 7
    const indicator_on = Math.floor(BikeRadio.elapsed(now, indicator_started) / BLINK_INTERVAL) % 2 == 0
    const hazards_on = mode == BikeRadio.Mode.Hazards &&
        Math.floor(BikeRadio.elapsed(now, mode_started) / BLINK_INTERVAL) % 2 == 0
    const left_on = hazards_on || (mode != BikeRadio.Mode.Hazards &&
        (desired_state & BikeRadio.LEFT) != 0 && indicator_on)
    const right_on = hazards_on || (mode != BikeRadio.Mode.Hazards &&
        (desired_state & BikeRadio.RIGHT) != 0 && indicator_on)
    const night = (desired_state & BikeRadio.NIGHT) != 0
    const brightness = brake_sensor.braking ? 255 : (night ? NIGHT_BRIGHTNESS : 0)
    rear_strip.fill(LEFT_INDICATOR_END, RIGHT_INDICATOR_START, 0xff0000, brightness)
    rear_strip.fill(0, LEFT_INDICATOR_END, left_on ? 0xffa500 : 0, 128)
    rear_strip.fill(RIGHT_INDICATOR_START, STRIP_LENGTH, right_on ? 0xffa500 : 0, 128)
    if (left_on)
        state |= BikeRadio.LEFT_ON
    if (right_on)
        state |= BikeRadio.RIGHT_ON
    if (brake_sensor.braking)
        state |= BikeRadio.BRAKE_ON
    updateRenderedState(state)
    rear_strip.show()
}

function sendStatus(now: number) {
    const rear_due = (status_due & 1) != 0 || BikeRadio.elapsed(now, last_rear_status) >= STATUS_INTERVAL
    const cabin_due = (status_due & 2) != 0 || BikeRadio.elapsed(now, last_cabin_status) >= STATUS_INTERVAL
    if (!rear_due && !cabin_due)
        return
    // Alternate acknowledgements; never send both radio packets back-to-back.
    const domain = rear_due && (!cabin_due || last_status_domain == BikeRadio.Domain.Cabin) ?
        BikeRadio.Domain.Rear : BikeRadio.Domain.Cabin
    const peer = domain == BikeRadio.Domain.Rear ? rear_peer : cabin_peer
    status_due &= ~(1 << domain)
    last_status_domain = domain
    if (domain == BikeRadio.Domain.Rear)
        last_rear_status = now
    else
        last_cabin_status = now
    status_revision = (status_revision + 1) % 65536
    let state = (rendered_state < 0 || startup ? desired_state : rendered_state) & ~BikeRadio.BRAKE_READY
    if (acceleration_mapper.state == AccelerationCalibrationState.Ready)
        state |= BikeRadio.BRAKE_READY
    radio.sendBuffer(BikeRadio.packet(BikeRadio.statusType(domain), lights_session,
        peer.session, peer.sequence, state, status_revision))
}

basic.forever(function () {
    const now = input.runningTime()
    pollButtons(now)
    if (rear_inbox != null) {
        const data = rear_inbox
        rear_inbox = null
        receiveCommand(data, now)
    }
    if (cabin_inbox != null) {
        const data = cabin_inbox
        cabin_inbox = null
        receiveCommand(data, now)
    }
    while (light_actions.length > 0)
        applyState(BikeRadio.change(desired_state, light_actions.shift()), now, true)
    if (BikeRadio.elapsed(now, last_sample) >= 20) {
        last_sample = now
        brake_sensor.sample(acceleration_mapper.sample(input.acceleration(Dimension.X),
            input.acceleration(Dimension.Y), input.acceleration(Dimension.Z), now))
    }
    if (BikeRadio.elapsed(now, last_frame) >= FRAME_INTERVAL) {
        last_frame = now
        renderLights(now)
    }
    updateDisplay()
    sendStatus(now)
    basic.pause(20)
})
