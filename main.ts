const PAUSE_QUANTUM = 50
const STANDARD_QUANTUM = 4

const RADIO_GROUP = 99
const SAMPLE_SIZE = 10
const BRAKE_THRESHOLD = 1100
const ACCEL_THRESHOLD = 1000

const STRIP_LENGTH = 96
const INDICATOR_LIGHT_START = 0
const INDICATOR_LIGHT_END = 30
const BRAKE_LIGHT_START = INDICATOR_LIGHT_END
const BRAKE_LIGHT_END = 75
const INTERIOR_LIGHT_START = BRAKE_LIGHT_END
const INTERIOR_LIGHT_END = STRIP_LENGTH

const NIGHT_LIGHT_BRIGHTNESS = 8
const INTERIOR_LIGHT_BRIGHTNESS = 64;
const BRAKE_LIGHT_BRIGHTNESS = 255



enum BikeState {
    Accelerating,
    Braking
}

class AccelerometerAverage {
    _samples: number[]
    _sample_index = 0;
    _last_sample = 0
    _state = BikeState.Braking
    constructor() {
        this._last_sample = 0
        this._samples = [];
        for (let i = 0; i < SAMPLE_SIZE; i++) {
            this._samples.push(0)
        }
    }

    get state() {
        return this._state;
    }

    sample() {
        const sample = input.acceleration(Dimension.Strength)
        this._samples[this._sample_index] = sample;

        this._sample_index = (this._sample_index + 1) % SAMPLE_SIZE;

        if (this._sample_index == 0) {
            this._computeAverageSample()
        }
    }

    _computeAverageSample() {
        let avg = 0;
        for (let j = 0; j < SAMPLE_SIZE; j++) {
            avg += this._samples[j];
        }

        avg = avg / SAMPLE_SIZE;

        if (avg > BRAKE_THRESHOLD) {
            this._state = BikeState.Braking
        } else if (avg < ACCEL_THRESHOLD) {
            this._state = BikeState.Accelerating
        }
    }
}

enum ControlCommand {
    Clear = 0,
    IndicateLeft,
    IndicateRight,
    NightMode,
    DayMode,
    NextMode,
    ForceBrakeLights
}

enum LightEffectMode {
    BikeLights,
    BumbleBee,
    Rainbow,
    Hazards,
}

enum LightState {
    Brake = 0x01,
    LeftIndicate = 0x02,
    RightIndicate = 0x04
}

enum LightMode {
    Braking = 0x10,
    IndicateLeft = 0x20,
    IndicateRight = 0x40,
    NightLights = 0x80
}

class BikeLightState {
    _light_state:number;
    constructor() {
        this._light_state = 0;
    }


    reset() {
        this._light_state = 0;
    }

    get state(): number {
        return this._light_state;
    }

    toggle_mode(mode: LightMode) {
        this.get_flag(mode) ? this.unset_flag(mode) : this.set_flag(mode)
    }

    toggle_state(state: LightState) {
        console.log(`get flag: ${this.get_flag(state)}`)
        this.get_flag(state) ? this.unset_flag(state) : this.set_flag(state)
    }

    get_flag(flag: number) : boolean {
        return (this.state & flag) > 0
    }

    set_flag(flag: number){
        this._light_state |= flag
    }

    unset_flag(flag: number) {
        this._light_state &= ~(flag)
    }

    toggle_left_indicator() {
        this.toggle_state(LightState.LeftIndicate)
    }

    toggle_right_indicator() {
        this.toggle_state(LightState.RightIndicate)
    }
}

const broadcastLightEffect = (state: LightEffectMode) => {
    radio.sendNumber(state)
}

const broadcastEffectCommand = (command: number) => {
    if (command <= 0xf)
        return;
    radio.sendNumber(command)
}

const setAllRgb = (strip: neopixel.Strip, rgb: number)=>{
    for (let i = 0; i < strip.length(); i++) 
        strip.setPixelColor(i, rgb)
}

class Effect {
    left_strip: neopixel.Strip
    right_strip: neopixel.Strip
    tick_rate: number
    constructor(left_strip: neopixel.Strip, right_strip: neopixel.Strip) {
        this.left_strip = left_strip
        this.right_strip = right_strip
        this.tick_rate = STANDARD_QUANTUM;
    }

    default_strip_settings() {
        this.left_strip.clear()
        this.right_strip.clear()
        this.left_strip.setBrightness(128)
        this.right_strip.setBrightness(128)
    }

    initialise() {
        this.default_strip_settings()
    }

    tick() {

    }

    done() : boolean {
        return false
    }
}

const KNIGHT_RIDE_START = (BRAKE_LIGHT_END - 25)

class KnightRider extends Effect {
    anim_idx: number
    complete: boolean
    left_to_right: boolean
    anim_count: number
    inc_dec:number
    constructor(left_strip: neopixel.Strip, right_strip: neopixel.Strip) {
        super(left_strip, right_strip)
        this.tick_rate = 1;
        this.anim_idx = 0
        this.left_to_right = true
        this.complete = false
        this.anim_count = 0
    }

    done() {
        return this.complete
    }

    initialise() {
        this.default_strip_settings()
        this.anim_idx = 0
    }

    tick() {
        const idx = this.anim_idx

        this.left_strip.clear()
        this.right_strip.clear()

        if (idx > KNIGHT_RIDE_START) {
            this.right_strip.setPixelColor(this.anim_idx - KNIGHT_RIDE_START, 0xff0000)
        } else {
            this.left_strip.setPixelColor(KNIGHT_RIDE_START - this.anim_idx, 0xff0000)
        }


        if (this.left_to_right)
            this.anim_idx++;
        else    
            this.anim_idx--;

        if (this.anim_idx == (2 * KNIGHT_RIDE_START) || this.anim_idx == 0) {
            this.anim_count++
            this.left_to_right = !this.left_to_right;
        }

        if (this.anim_count > 2) {
            this.complete = true
        }
            
    }
}

class Smile extends Effect {
    smile_idx: number
    smile_complete: boolean
    wink_complete: boolean
    constructor(left_strip: neopixel.Strip, right_strip: neopixel.Strip) {
        super(left_strip, right_strip)
        this.tick_rate = 1;
        this.smile_idx = 0
        this.smile_complete = false
        this.wink_complete = false
    }

    done() {
        return this.smile_complete && this.wink_complete
    }

    initialise() {
        this.default_strip_settings()
        this.smile_idx = 0
    }

    tick () {
        const idx = this.smile_idx
        if (idx < 40) {
            this.left_strip.setPixelColor(idx, 0xffffff);
            this.right_strip.setPixelColor(idx, 0xffffff);
            
        } else {
            let col = 0xffffff;
            if (idx > 140) {
                this.smile_complete = true;
                col = 0
            }
                
            if (idx > 240)
                col = 0xffffff

            if (idx > 340)
                this.wink_complete = true;

            if (!this.smile_complete) {
                for (let i = INTERIOR_LIGHT_START; i > INTERIOR_LIGHT_START - 15; i--) {
                    this.left_strip.setPixelColor(i, col);
                    this.right_strip.setPixelColor(i, col);
                }
            } else {
                // wink right
                for (let i = INTERIOR_LIGHT_START; i > INTERIOR_LIGHT_START - 15; i--) {
                    this.right_strip.setPixelColor(i, col);
                }
            }
        }

        this.smile_idx++;
    }
}

class BumbleBee extends Effect {
    initialise() {
        this.default_strip_settings()

        for (let i = 0; i < STRIP_LENGTH; i++) {
            let col = 0
            if (i % 2 == 0) {
                col = 0xffff00;
            }
            this.left_strip.setPixelColor(i, col);
            this.right_strip.setPixelColor(i, col);
        }

        broadcastLightEffect(LightEffectMode.BumbleBee)
    }

    tick() {
        this.left_strip.rotate()
        this.right_strip.rotate()
    }
}

class Rainbow extends Effect {
    initialise() {
        this.default_strip_settings()
        this.left_strip.showRainbow()
        this.right_strip.showRainbow()

        broadcastLightEffect(LightEffectMode.Rainbow)
    }

    tick() {
        this.left_strip.rotate()
        this.right_strip.rotate()
    }
}

enum HazardsEffectState {
    On = 0x10,
    Off,
}
class Hazard extends Effect {
    on_off: boolean
    constructor(left_strip: neopixel.Strip, right_strip: neopixel.Strip) {
        super(left_strip, right_strip)
        this.on_off = false
    }

    initialise() {
        this.default_strip_settings();

        broadcastLightEffect(LightEffectMode.Hazards)
    }

    tick() {
        this.on_off = !this.on_off;

        if (this.on_off) {
            broadcastEffectCommand(HazardsEffectState.On)
            setAllRgb(this.left_strip, 0xffa500)
            setAllRgb(this.right_strip, 0xffa500)
        } else {
            broadcastEffectCommand(HazardsEffectState.Off)
            setAllRgb(this.left_strip, 0)
            setAllRgb(this.right_strip, 0)
        }
    }
}

enum BikeLightEffectState {
    LeftOn = 0x10,
    LeftOff,
    RightOn,
    RightOff
}
class BikeLights extends Effect {
    left_brake_range: neopixel.Strip
    left_indicator_range: neopixel.Strip
    left_interior_range: neopixel.Strip
    right_brake_range: neopixel.Strip
    right_indicator_range: neopixel.Strip
    right_interior_range: neopixel.Strip
    averager: AccelerometerAverage;
    inner_tick_rate: number

    constructor(left_strip: neopixel.Strip, right_strip: neopixel.Strip) {
        super(left_strip, right_strip)
        this.tick_rate = 1; // call each loop
        this.inner_tick_rate = 0;
        this.left_indicator_range = this.left_strip.range(INDICATOR_LIGHT_START, INDICATOR_LIGHT_END);
        this.left_brake_range = this.left_strip.range(INDICATOR_LIGHT_END, BRAKE_LIGHT_END - INDICATOR_LIGHT_END);
        this.left_interior_range = this.left_strip.range(BRAKE_LIGHT_END, INTERIOR_LIGHT_END - BRAKE_LIGHT_END)
        this.right_indicator_range = this.right_strip.range(INDICATOR_LIGHT_START, INDICATOR_LIGHT_END);
        this.right_brake_range = this.right_strip.range(INDICATOR_LIGHT_END, BRAKE_LIGHT_END - INDICATOR_LIGHT_END);
        this.right_interior_range = this.right_strip.range(BRAKE_LIGHT_END, INTERIOR_LIGHT_END - BRAKE_LIGHT_END)

        this.averager = new AccelerometerAverage()
    }
    
    initialise() {
        this.default_strip_settings()
        light_state.reset()
        this.inner_tick_rate = 0

        broadcastLightEffect(LightEffectMode.BikeLights)
    }

    tick() {
        averager.sample()

        if (averager.state == BikeState.Braking)
            light_state.set_flag(LightState.Brake)
        else
            light_state.unset_flag(LightState.Brake)

        if (light_state.get_flag(LightMode.NightLights)) {
            setAllRgb(this.left_brake_range, 0xff0000)
            setAllRgb(this.right_brake_range, 0xff0000)
            this.left_brake_range.setBrightness(NIGHT_LIGHT_BRIGHTNESS);
            this.right_brake_range.setBrightness(NIGHT_LIGHT_BRIGHTNESS);

            setAllRgb(this.left_interior_range, 0xffffff)
            setAllRgb(this.right_interior_range, 0xffffff)
            this.left_interior_range.setBrightness(INTERIOR_LIGHT_BRIGHTNESS)
            this.right_interior_range.setBrightness(INTERIOR_LIGHT_BRIGHTNESS)
        }

        if (light_state.get_flag(LightState.Brake)) {
            setAllRgb(this.left_brake_range, 0xff0000)
            setAllRgb(this.right_brake_range, 0xff0000)
            this.left_brake_range.setBrightness(BRAKE_LIGHT_BRIGHTNESS);
            this.right_brake_range.setBrightness(BRAKE_LIGHT_BRIGHTNESS);
        }

        if (!light_state.get_flag(LightMode.NightLights) && !light_state.get_flag(LightState.Brake)) {
            setAllRgb(this.left_brake_range, 0)
            setAllRgb(this.right_brake_range, 0)
        }
        
        this.inner_tick_rate = (this.inner_tick_rate + 1) % STANDARD_QUANTUM;

        if (this.inner_tick_rate == 0) {
            if (light_state.get_flag(LightMode.IndicateLeft)) {
                light_state.toggle_left_indicator()

                if (light_state.get_flag(LightState.LeftIndicate)) {
                    broadcastEffectCommand(BikeLightEffectState.LeftOn)
                    setAllRgb(this.left_indicator_range, 0xffa500)
                } else {
                    setAllRgb(this.left_indicator_range, 0)
                    broadcastEffectCommand(BikeLightEffectState.LeftOff)
                }
                    
            } else {
                setAllRgb(this.left_indicator_range, 0)
            }

            if (light_state.get_flag(LightMode.IndicateRight)) {
                light_state.toggle_right_indicator()

                if (light_state.get_flag(LightState.RightIndicate)) {
                    broadcastEffectCommand(BikeLightEffectState.RightOn)
                    setAllRgb(this.right_indicator_range, 0xffa500)
                } else {
                    setAllRgb(this.right_indicator_range, 0)
                    broadcastEffectCommand(BikeLightEffectState.RightOff)
                }
            } else {
                setAllRgb(this.right_indicator_range, 0)
            }
        }
        
    }
}

class BikeLightsFaked extends Effect {
    light_state: BikeLightState
    left_brake_range: neopixel.Strip
    left_indicator_range: neopixel.Strip
    left_interior_range: neopixel.Strip
    right_brake_range: neopixel.Strip
    right_indicator_range: neopixel.Strip
    right_interior_range: neopixel.Strip
    averager: AccelerometerAverage;
    inner_tick_rate: number

    constructor(left_strip: neopixel.Strip, right_strip: neopixel.Strip) {
        super(left_strip, right_strip)
        this.tick_rate = 1; // call each loop
        this.inner_tick_rate = 0;
        this.left_indicator_range = this.left_strip.range(INDICATOR_LIGHT_START, INDICATOR_LIGHT_END);
        this.left_brake_range = this.left_strip.range(INDICATOR_LIGHT_END, BRAKE_LIGHT_END - INDICATOR_LIGHT_END);
        this.left_interior_range = this.left_strip.range(BRAKE_LIGHT_END, INTERIOR_LIGHT_END - BRAKE_LIGHT_END)
        this.right_indicator_range = this.right_strip.range(INDICATOR_LIGHT_START, INDICATOR_LIGHT_END);
        this.right_brake_range = this.right_strip.range(INDICATOR_LIGHT_END, BRAKE_LIGHT_END - INDICATOR_LIGHT_END);
        this.right_interior_range = this.right_strip.range(BRAKE_LIGHT_END, INTERIOR_LIGHT_END - BRAKE_LIGHT_END)
    }

    initialise() {
        this.default_strip_settings()
        light_state.reset()
        this.inner_tick_rate = 0

        broadcastLightEffect(LightEffectMode.BikeLights)
    }

    tick() {
        light_state.set_flag(LightMode.NightLights)
        
        if (light_state.get_flag(LightMode.NightLights)) {
            setAllRgb(this.left_interior_range, 0xffffff)
            setAllRgb(this.right_interior_range, 0xffffff)
            this.left_interior_range.setBrightness(INTERIOR_LIGHT_BRIGHTNESS)
            this.right_interior_range.setBrightness(INTERIOR_LIGHT_BRIGHTNESS)
        }

        // light_state.set_flag(LightState.Brake);
        setAllRgb(this.left_brake_range, 0xff0000)
        setAllRgb(this.right_brake_range, 0xff0000)
        if (light_state.get_flag(LightState.Brake)) {
            this.left_brake_range.setBrightness(BRAKE_LIGHT_BRIGHTNESS);
            this.right_brake_range.setBrightness(BRAKE_LIGHT_BRIGHTNESS);
        } else {
            this.left_brake_range.setBrightness(NIGHT_LIGHT_BRIGHTNESS);
            this.right_brake_range.setBrightness(NIGHT_LIGHT_BRIGHTNESS);
        }

        this.inner_tick_rate = (this.inner_tick_rate + 1) % STANDARD_QUANTUM;

        if (this.inner_tick_rate == 0) {
            if (light_state.get_flag(LightMode.IndicateLeft)) {
                light_state.toggle_left_indicator()

                if (light_state.get_flag(LightState.LeftIndicate)) {
                    broadcastEffectCommand(BikeLightEffectState.LeftOn)
                    setAllRgb(this.left_indicator_range, 0xffa500)
                } else {
                    setAllRgb(this.left_indicator_range, 0)
                    broadcastEffectCommand(BikeLightEffectState.LeftOff)
                }

            } else {
                setAllRgb(this.left_indicator_range, 0)
            }

            if (light_state.get_flag(LightMode.IndicateRight)) {
                light_state.toggle_right_indicator()

                if (light_state.get_flag(LightState.RightIndicate)) {
                    broadcastEffectCommand(BikeLightEffectState.RightOn)
                    setAllRgb(this.right_indicator_range, 0xffa500)
                } else {
                    setAllRgb(this.right_indicator_range, 0)
                    broadcastEffectCommand(BikeLightEffectState.RightOff)
                }
            } else {
                setAllRgb(this.right_indicator_range, 0)
            }
        }

    }
}

radio.setGroup(RADIO_GROUP)
radio.setTransmitPower(7)


const processControlCommand = (command: number) => {
    switch (command) {
        case ControlCommand.Clear:
            control.reset()
            light_state.reset()
            effects_idx = 0;
            basic.showNumber(0);
            break
        case ControlCommand.IndicateLeft:
            light_state.unset_flag(LightMode.IndicateRight)
            light_state.toggle_mode(LightMode.IndicateLeft)
            break
        case ControlCommand.IndicateRight:
            light_state.unset_flag(LightMode.IndicateLeft)
            light_state.toggle_mode(LightMode.IndicateRight)
            break
        case ControlCommand.NightMode:
            light_state.set_flag(LightMode.NightLights)
            break
        case ControlCommand.DayMode:
            light_state.unset_flag(LightMode.NightLights)
            break
        case ControlCommand.NextMode:
            effects_idx = (effects_idx + 1) % effects.length
            basic.showNumber(effects_idx)
            break
        case ControlCommand.ForceBrakeLights:
            light_state.toggle_state(LightState.Brake)
            break
    }
}

radio.onReceivedNumber((receivedNumber) => {
    processControlCommand(receivedNumber)
})

const averager = new AccelerometerAverage()
const light_state = new BikeLightState()

let left_strip = neopixel.create(DigitalPin.P0, STRIP_LENGTH, NeoPixelMode.RGB)
let right_strip = neopixel.create(DigitalPin.P1, STRIP_LENGTH, NeoPixelMode.RGB)

let effects = [new BikeLightsFaked(left_strip, right_strip), new Hazard(left_strip, right_strip), new Rainbow(left_strip, right_strip), new BumbleBee(left_strip, right_strip), new BikeLightsFaked(left_strip, right_strip)]
let effects_idx = 0

input.onButtonPressed(Button.AB, function() {
    processControlCommand(ControlCommand.NextMode)
})

input.onButtonPressed(Button.A, function () {
    processControlCommand(ControlCommand.IndicateLeft)
})
 
input.onButtonPressed(Button.B, function () {
    // if (effects_idx == 4)
    // {
        processControlCommand(ControlCommand.ForceBrakeLights)
    // } else {
    //     processControlCommand(ControlCommand.IndicateRight)
    // }
    
})

const startupEffect = new KnightRider(left_strip, right_strip)

while (!startupEffect.done()) {
    startupEffect.tick()
    left_strip.show()
    right_strip.show()
    pause(5);
}

const br = [0, 16, 32,64,128, 0xff]

setAllRgb(left_strip, 0xffffff)
setAllRgb(right_strip, 0xffffff)

for (let brightness of br) {
    left_strip.setBrightness(brightness)
    left_strip.show()
    right_strip.show()
    pause(25)
}

basic.showNumber(effects_idx);

let prev_effect_idx = -1;
let effect_counter = 0;
basic.forever(function () {
    const effect: Effect = effects[effects_idx]

    if (prev_effect_idx != effects_idx) {
        effect_counter = 0;
        effect.initialise()
        console.log("init")
        prev_effect_idx = effects_idx;
        left_strip.show()
        right_strip.show()
    }

    effect_counter = (effect_counter + 1) % effect.tick_rate;

    if (effect_counter == 0) {
        effect.tick()
        left_strip.show()
        right_strip.show()
    }
    basic.pause(PAUSE_QUANTUM)
})
