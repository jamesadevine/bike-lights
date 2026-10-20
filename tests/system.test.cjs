const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

const lightsRoot = path.resolve(__dirname, '..');
const controllerRoot = path.resolve(lightsRoot, '..', 'bike-light-controller');
const cabinRoot = path.resolve(lightsRoot, '..', 'bike-light-cabin-controller');
let session = 100;

class RadioBuffer extends Uint8Array {
    setNumber(format, offset, value) {
        const view = new DataView(this.buffer, this.byteOffset, this.byteLength);
        if (format === 4) view.setUint32(offset, value, true);
        else view.setUint16(offset, value, true);
    }
    getNumber(format, offset) {
        const view = new DataView(this.buffer, this.byteOffset, this.byteLength);
        return format === 4 ? view.getUint32(offset, true) : view.getUint16(offset, true);
    }
}

function app(root, network, name) {
    const buttons = {};
    const loops = [];
    const strips = [];
    const logs = [];
    let receive;
    const io = { z: 0, light: 80, display: '', sends: 0 };
    const context = vm.createContext({
        console: { log: message => logs.push(message) },
        randint: (min, max) => max > 10000 ? ++session : Math.floor((min + max) / 2),
        NumberFormat: { UInt32LE: 4, UInt16LE: 2 },
        pins: { createBuffer: length => new RadioBuffer(length) },
        radio: {
            setGroup() {}, setTransmitPower() {},
            onReceivedBuffer: handler => { receive = handler; },
            sendBuffer(data) {
                io.sends++;
                network.queue.push({ from: name, data: new RadioBuffer(data), time: network.now });
            }
        },
        input: {
            runningTime: () => network.now >>> 0,
            acceleration: dimension => { assert.equal(dimension, 2); return io.z; },
            lightLevel: () => io.light,
            onButtonPressed: (button, handler) => { buttons[button] = handler; }
        },
        basic: {
            forever: handler => loops.push(handler),
            pause() {},
            showString: (value, interval) => { assert.equal(interval, 0); io.display = value; },
            showArrow: (value, interval) => { assert.equal(interval, 0); io.display = value; },
            clearScreen: () => { io.display = ''; }
        },
        Button: { A: 'A', B: 'B', AB: 'AB' },
        ArrowNames: { West: 'left', East: 'right' },
        DigitalPin: { P0: 0, P1: 1 },
        Dimension: { Z: 2 },
        NeoPixelMode: { RGB: 1 },
        neopixel: {
            create(pin, length) {
                const strip = {
                    pixels: new Array(length).fill(0),
                    frames: [],
                    brightness: 128,
                    setBrightness(value) { this.brightness = value; },
                    setPixelColor(index, color) {
                        assert.ok(index >= 0 && index < length);
                        assert.equal(this.brightness, 255);
                        this.pixels[index] = color;
                    },
                    show() { this.frames.push(this.pixels.slice()); }
                };
                strips.push(strip);
                return strip;
            },
            hsl: hue => (Math.floor(hue) + 1) * 257
        }
    });
    for (const file of ['protocol.ts', 'client.ts', 'main.ts']) {
        if (file === 'client.ts' && !fs.existsSync(path.join(root, file))) continue;
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }), context, { filename: file });
    }
    assert.equal(loops.length, 1);
    return {
        io, strips, logs,
        run: expression => vm.runInContext(expression, context),
        tick: () => loops[0](),
        button: button => buttons[button](),
        receive: data => receive(new RadioBuffer(data))
    };
}

function pair(withController = true, withCabin = false) {
    const network = { now: 0, queue: [], history: [], drop: () => false };
    const rig = {
        network,
        lights: app(lightsRoot, network, 'lights'),
        controller: withController ? app(controllerRoot, network, 'controller') : null,
        cabin: withCabin ? app(cabinRoot, network, 'cabin') : null,
        step() {
            network.now += 20;
            const packets = network.queue.splice(0);
            for (const packet of packets) {
                network.history.push(packet);
                if (!network.drop(packet)) {
                    for (const [name, destination] of [
                        ['lights', this.lights], ['controller', this.controller], ['cabin', this.cabin]
                    ]) {
                        if (destination && name !== packet.from) destination.receive(packet.data);
                    }
                }
            }
            this.lights.tick();
            if (this.controller) this.controller.tick();
            if (this.cabin) this.cabin.tick();
        },
        advance(milliseconds) {
            for (let i = 0; i < milliseconds; i += 20) this.step();
        },
        restartController() { this.controller = app(controllerRoot, network, 'controller'); },
        restartCabin() { this.cabin = app(cabinRoot, network, 'cabin'); },
        restartLights() { this.lights = app(lightsRoot, network, 'lights'); }
    };
    return rig;
}

function desired(rig) { return rig.lights.run('desired_state'); }
function command(rig, sequence, state, controllerSession) {
    return rig.lights.run(`BikeRadio.packet(BikeRadio.PacketType.RearCommand, lights_session,
        ${controllerSession || 999}, ${sequence}, ${state}, 0)`);
}
function setState(rig, state) {
    const sequence = rig.lights.run('rear_peer.sequence') + 1;
    rig.lights.receive(command(rig, sequence, state));
    rig.advance(20);
}

function cabinCommand(rig, sequence, state, controllerSession = 888) {
    return rig.lights.run(`BikeRadio.packet(BikeRadio.PacketType.CabinCommand, lights_session,
        ${controllerSession}, ${sequence}, ${state}, 0)`);
}

test('all three apps have identical protocols and both controllers share the same transport', () => {
    for (const root of [controllerRoot, cabinRoot])
        assert.equal(fs.readFileSync(path.join(lightsRoot, 'protocol.ts'), 'utf8'),
            fs.readFileSync(path.join(root, 'protocol.ts'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(controllerRoot, 'client.ts'), 'utf8'),
        fs.readFileSync(path.join(cabinRoot, 'client.ts'), 'utf8'));
});

test('standalone lights start in automatic night mode, calibrate, and accept local buttons', () => {
    const rig = pair(false);
    rig.advance(2200);
    assert.equal(desired(rig), 4 | 32);
    assert.equal(rig.lights.run('brake_sensor.calibrated'), true);
    assert.equal(rig.lights.run('brake_sensor.braking'), false);
    assert.equal(rig.lights.strips[1].pixels[30], 0x070000);
    assert.equal(rig.lights.strips[0].pixels[75], 0x3f3f3f);
    rig.lights.button('B');
    rig.advance(20);
    assert.equal(desired(rig), 4 | 32 | 16);
    assert.notEqual(rig.lights.strips[1].pixels[95], 0);
    rig.lights.button('AB');
    rig.advance(20);
    assert.equal(desired(rig) & 7, 1);
});

test('lost command is retried; duplicate delivery does not toggle twice', () => {
    const rig = pair();
    rig.advance(400);
    let dropped = false;
    rig.network.drop = packet => {
        if (packet.from === 'controller' && !dropped) { dropped = true; return true; }
        return false;
    };
    rig.controller.button('A');
    rig.advance(700);
    assert.equal(dropped, true);
    assert.ok(desired(rig) & 8);
    assert.equal(rig.controller.run('client.pending'), false);
    const packet = rig.network.history.filter(packet => packet.from === 'controller').at(-1);
    rig.lights.receive(packet.data);
    rig.advance(20);
    assert.ok(desired(rig) & 8);
});

test('lost acknowledgements are recovered without repeating the action', () => {
    const rig = pair();
    rig.advance(400);
    const start = rig.network.now;
    rig.network.drop = packet => packet.from === 'lights' && rig.network.now - start < 500;
    rig.controller.button('AB');
    rig.advance(900);
    assert.equal(desired(rig) & 7, 1);
    assert.equal(rig.controller.run('client.pending'), false);
    assert.ok(rig.controller.io.sends >= 2);
});

test('rapid actions coalesce into the complete intended state', () => {
    const rig = pair();
    rig.advance(400);
    rig.controller.button('AB');
    rig.controller.button('AB');
    rig.controller.button('AB');
    rig.controller.button('A');
    rig.controller.button('B');
    rig.advance(400);
    assert.equal(desired(rig), 4 | 16);
});

test('commands received during startup survive and cancel the animation', () => {
    const rig = pair();
    rig.advance(80);
    rig.controller.button('A');
    rig.advance(140);
    assert.ok(desired(rig) & 8);
    assert.equal(rig.lights.run('startup'), false);
    assert.notEqual(rig.lights.strips[1].pixels[0], 0);
});

test('mode and indicator changes together are not erased by initialization', () => {
    const rig = pair(false);
    setState(rig, 1);
    setState(rig, 4 | 8 | 32);
    assert.equal(desired(rig), 4 | 8 | 32);
    assert.equal(rig.lights.run('rendered_state') & (7 | 8 | 32 | 0x1000), 4 | 8 | 32 | 0x1000);
});

test('stale commands cannot undo newer state', () => {
    const rig = pair(false);
    rig.lights.receive(command(rig, 2, 4 | 8));
    rig.advance(20);
    rig.lights.receive(command(rig, 1, 1));
    rig.advance(20);
    assert.equal(desired(rig), 4 | 8);
    assert.equal(rig.lights.run('rear_peer.sequence'), 2);
});

test('hazards status contains mode and phase even if its first status is lost', () => {
    const rig = pair();
    rig.advance(400);
    let dropped = false;
    rig.network.drop = packet => {
        if (packet.from === 'lights' && !dropped) { dropped = true; return true; }
        return false;
    };
    rig.controller.button('AB');
    rig.advance(500);
    assert.equal(desired(rig) & 7, 1);
    assert.equal(rig.controller.run('client.reported_state') & 7, 1);
    assert.notEqual(rig.controller.io.display, 'left');
});

test('indicator Off is acknowledged immediately and the next activation starts On', () => {
    const rig = pair();
    rig.advance(400);
    rig.controller.button('A');
    rig.advance(100);
    assert.equal(rig.controller.io.display, 'left');
    rig.controller.button('A');
    rig.advance(100);
    assert.equal(rig.lights.strips[1].pixels[0], 0);
    assert.equal(rig.controller.io.display, '');
    rig.controller.button('A');
    rig.advance(100);
    assert.equal(rig.controller.io.display, 'left');
});

test('controller restart does not clear or reboot lights', () => {
    const rig = pair();
    rig.advance(400);
    rig.lights.button('A');
    rig.advance(100);
    const boot = rig.lights.run('lights_session');
    const state = desired(rig);
    rig.restartController();
    rig.advance(400);
    assert.equal(rig.lights.run('lights_session'), boot);
    assert.equal(desired(rig), state);
    assert.equal(rig.lights.run('startup'), false);
});

test('pending desired state is retargeted after a light-board restart', () => {
    const rig = pair();
    rig.advance(400);
    rig.network.drop = packet => packet.from === 'controller';
    rig.controller.button('A');
    rig.advance(100);
    const oldCommand = rig.network.history.filter(packet => packet.from === 'controller').at(-1);
    rig.restartLights();
    rig.network.drop = () => false;
    rig.advance(500);
    assert.ok(desired(rig) & 8);
    assert.equal(rig.controller.run('client.pending'), false);
    const state = desired(rig);
    rig.lights.receive(oldCommand.data);
    rig.advance(20);
    assert.equal(desired(rig), state);
});

test('late packets from retired controller sessions cannot take control again', () => {
    const rig = pair();
    rig.advance(400);
    rig.controller.button('A');
    rig.advance(200);
    const oldCommand = rig.network.history.filter(packet => packet.from === 'controller').at(-1);
    rig.restartController();
    rig.advance(400);
    rig.controller.button('B');
    rig.advance(200);
    const state = desired(rig);
    rig.lights.receive(oldCommand.data);
    rig.advance(20);
    assert.equal(desired(rig), state);
});

test('stale status revisions cannot overwrite a newer controller display', () => {
    const rig = pair();
    rig.advance(400);
    const oldStatus = rig.network.history.filter(packet => packet.from === 'lights').at(-1);
    rig.controller.button('AB');
    rig.advance(200);
    assert.equal(rig.controller.run('client.reported_state') & 7, 1);
    rig.controller.receive(oldStatus.data);
    rig.controller.tick();
    assert.equal(rig.controller.run('client.reported_state') & 7, 1);
});

test('status revision wrap and a long outage both recover', () => {
    const rig = pair();
    rig.advance(400);
    rig.lights.run('status_revision = 65534');
    rig.controller.run('client.status_revision = 65534');
    rig.advance(600);
    assert.ok(rig.controller.run('client.status_revision') < 20);
    rig.network.drop = packet => packet.from === 'lights';
    rig.advance(1800);
    assert.equal(rig.controller.io.display, '!');
    rig.lights.run('status_revision = 40000');
    rig.network.drop = () => false;
    rig.advance(400);
    assert.notEqual(rig.controller.io.display, '!');
    assert.ok(rig.controller.run('client.status_revision') >= 40000);
});

test('late snapshots from a retired light-board boot cannot replace the new boot', () => {
    const rig = pair();
    rig.advance(400);
    const oldStatus = rig.network.history.filter(packet => packet.from === 'lights').at(-1);
    rig.restartLights();
    rig.advance(400);
    const boot = rig.controller.run('client.lights_session');
    rig.controller.receive(oldStatus.data);
    rig.controller.tick();
    assert.equal(rig.controller.run('client.lights_session'), boot);
});

test('actions queued before discovering lights apply to their actual default state', () => {
    const rig = pair();
    rig.controller.button('A');
    rig.advance(200);
    assert.equal(desired(rig) & (7 | 8 | 16), 4 | 8);
});

test('controller command sequence rollover starts a new session', () => {
    const rig = pair();
    rig.advance(400);
    const oldSession = rig.controller.run('client.session');
    rig.controller.run('client.sequence = BikeRadio.MAX_SEQUENCE');
    rig.controller.button('B');
    rig.advance(300);
    assert.notEqual(rig.controller.run('client.session'), oldSession);
    assert.equal(rig.controller.run('client.sequence'), 1);
    assert.ok(desired(rig) & 16);
    assert.equal(rig.controller.run('client.pending'), false);
});

test('retry exhaustion is visible and bounded; a new action can recover', () => {
    const rig = pair();
    rig.advance(400);
    const before = rig.controller.io.sends;
    rig.network.drop = packet => packet.from === 'controller';
    rig.controller.button('A');
    rig.advance(2200);
    assert.equal(rig.controller.io.sends - before, 8);
    assert.equal(rig.controller.io.display, '!');
    assert.ok(rig.controller.logs.some(message => message.includes('8 attempts')));
    rig.network.drop = () => false;
    rig.controller.button('B');
    rig.advance(300);
    assert.ok(desired(rig) & 16);
    assert.equal(desired(rig) & 8, 0);
    assert.equal(rig.controller.run('client.pending'), false);
});

test('link loss clears controller indication but never stops standalone lighting', () => {
    const rig = pair();
    rig.advance(400);
    rig.controller.button('A');
    rig.advance(100);
    rig.network.drop = packet => packet.from === 'lights';
    rig.advance(2000);
    assert.equal(rig.controller.io.display, '!');
    assert.ok(desired(rig) & 8);
    rig.lights.button('B');
    rig.advance(20);
    assert.ok(desired(rig) & 16);
});

test('day mode changes only rear tail lighting, never front interior lighting', () => {
    const rig = pair(false);
    for (const mode of [1, 4]) {
        setState(rig, mode | 32);
        assert.notEqual(rig.lights.strips[0].pixels[75], 0);
        setState(rig, mode);
        assert.equal(rig.lights.strips[0].pixels[75], 0x3f3f3f);
        assert.equal(rig.lights.strips[1].pixels[48], 0);
        rig.advance(100);
        assert.equal(desired(rig) & 32, 0);
    }
});

test('signed Z braking is full brightness at night and releases at rest', () => {
    const rig = pair(false);
    rig.lights.io.z = 30;
    rig.advance(2200);
    assert.equal(rig.lights.run('brake_sensor.baseline'), 30);
    assert.equal(rig.lights.run('brake_sensor.braking'), false);
    rig.lights.io.z = -270;
    rig.advance(400);
    assert.equal(rig.lights.run('brake_sensor.braking'), false);
    rig.lights.io.z = 330;
    rig.advance(400);
    assert.equal(rig.lights.run('brake_sensor.braking'), true);
    assert.equal(rig.lights.strips[0].pixels[30], 0x3f3f3f);
    assert.equal(rig.lights.strips[1].pixels[30], 0xff0000);
    rig.lights.io.z = 30;
    rig.advance(400);
    assert.equal(rig.lights.run('brake_sensor.braking'), false);
    assert.equal(rig.lights.strips[1].pixels[30], 0x070000);
});

test('moving calibration is rejected and retried instead of latching a brake', () => {
    const rig = pair(false);
    for (let i = 0; i < 50; i++) {
        rig.lights.io.z = i % 2 ? 300 : -300;
        rig.step();
    }
    assert.equal(rig.lights.run('brake_sensor.calibrated'), false);
    assert.ok(rig.lights.logs.some(message => message.includes('stationary')));
    rig.lights.io.z = 0;
    rig.advance(1000);
    assert.equal(rig.lights.run('brake_sensor.calibrated'), true);
    assert.equal(rig.lights.run('brake_sensor.braking'), false);
});

test('unchanged frames do not retransmit NeoPixel buffers', () => {
    const rig = pair(false);
    rig.advance(2200);
    const frames = rig.lights.strips.map(strip => strip.frames.length);
    rig.advance(1000);
    assert.deepEqual(rig.lights.strips.map(strip => strip.frames.length), frames);
});

test('rear startup ramp is red and never changes front interior white', () => {
    const rig = pair(false);
    rig.advance(2200);
    const colors = rig.lights.strips[1].frames.filter(frame => frame.every(color => color === frame[0]))
        .map(frame => frame[0]);
    for (const color of [0, 0x0f0000, 0x1f0000, 0x3f0000, 0x7f0000, 0xff0000])
        assert.ok(colors.includes(color), color.toString(16));
    assert.ok(rig.lights.strips[0].frames.every(frame => frame.every(color => color === 0x3f3f3f)));
});

test('controller light sensor actually runs and uses hysteresis', () => {
    const rig = pair();
    rig.controller.io.light = 20;
    rig.advance(700);
    assert.ok(desired(rig) & 32);
    rig.controller.io.light = 50;
    rig.advance(400);
    assert.ok(desired(rig) & 32);
    rig.controller.io.light = 80;
    rig.advance(400);
    assert.equal(desired(rig) & 32, 0);
});

test('an initial ambient reading in the deadband retains night mode', () => {
    const rig = pair();
    rig.controller.io.light = 50;
    rig.advance(700);
    assert.ok(desired(rig) & 32);
});

test('rear arch uses exactly the left quarter, middle half, and right quarter', () => {
    const rig = pair(false);
    setState(rig, 4 | 32 | 8);
    const front = rig.lights.strips[0].pixels;
    const rear = rig.lights.strips[1].pixels;
    assert.equal(front.length, 96);
    assert.ok(front.every(color => color === 0x3f3f3f));
    assert.ok(rear.slice(0, 24).every(color => color === 0x7f5200));
    assert.ok(rear.slice(24, 72).every(color => color === 0x070000));
    assert.ok(rear.slice(72).every(color => color === 0));
    setState(rig, 4 | 32 | 16);
    assert.ok(rear.slice(0, 24).every(color => color === 0));
    assert.ok(rear.slice(24, 72).every(color => color === 0x070000));
    assert.ok(rear.slice(72).every(color => color === 0x7f5200));
});

test('hazards never replace the center brake light or affect front lighting', () => {
    const rig = pair(false);
    rig.advance(2200);
    rig.lights.io.z = 300;
    rig.advance(300);
    rig.lights.button('AB');
    rig.advance(20);
    const rear = rig.lights.strips[1].pixels;
    assert.ok(rear.slice(0, 24).every(color => color === 0x7f5200));
    assert.ok(rear.slice(24, 72).every(color => color === 0xff0000));
    assert.ok(rear.slice(72).every(color => color === 0x7f5200));
    rig.advance(260);
    assert.ok(rear.slice(0, 24).every(color => color === 0));
    assert.ok(rear.slice(24, 72).every(color => color === 0xff0000));
    assert.ok(rear.slice(72).every(color => color === 0));
    assert.ok(rig.lights.strips[0].pixels.every(color => color === 0x3f3f3f));
});

test('rear controls toggle hazards and turn selection cancels hazards', () => {
    const rig = pair();
    rig.advance(400);
    rig.controller.button('AB');
    rig.advance(100);
    assert.equal(desired(rig) & 7, 1);
    rig.controller.button('A');
    rig.advance(100);
    assert.equal(desired(rig) & (7 | 8 | 16), 4 | 8);
    rig.controller.button('AB');
    rig.advance(100);
    assert.equal(desired(rig) & (7 | 8 | 16), 1);
    rig.controller.button('AB');
    rig.advance(100);
    assert.equal(desired(rig) & (7 | 8 | 16), 4);
});

test('cabin works without a rear controller and cycles the complete front palette', () => {
    const rig = pair(false, true);
    rig.advance(100);
    const modes = [
        ['W', 0x3f3f3f], ['Y', 0x3f2a15], ['R', 0x3f0000],
        ['G', 0x003f00], ['B', 0x00003f], ['*', null], ['O', 0], ['W', 0x3f3f3f]
    ];
    for (let i = 0; i < modes.length; i++) {
        if (i > 0) {
            rig.cabin.button('A');
            rig.advance(100);
        }
        const [label, color] = modes[i];
        assert.equal(rig.cabin.io.display, label);
        if (color !== null)
            assert.ok(rig.lights.strips[0].pixels.every(pixel => pixel === color), label);
        assert.equal(desired(rig) & 0x3f, 4 | 32);
        assert.equal(rig.cabin.run('client.pending'), false);
    }
});

test('cabin brightness cycles independently and wraps to its default', () => {
    const rig = pair(false, true);
    rig.advance(100);
    for (const color of [0x7f7f7f, 0xbfbfbf, 0xffffff, 0x3f3f3f]) {
        rig.cabin.button('B');
        rig.advance(100);
        assert.ok(rig.lights.strips[0].pixels.every(pixel => pixel === color));
        assert.equal(desired(rig) & 0x3f, 4 | 32);
    }
});

test('front power restores color and brightness even after a cabin-controller restart', () => {
    const rig = pair(false, true);
    rig.advance(100);
    for (let i = 0; i < 4; i++) rig.cabin.button('A');
    rig.cabin.button('B');
    rig.advance(120);
    assert.ok(rig.lights.strips[0].pixels.every(color => color === 0x00007f));
    const selected = desired(rig);
    rig.cabin.button('AB');
    rig.advance(100);
    assert.ok(rig.lights.strips[0].pixels.every(color => color === 0));
    rig.restartCabin();
    rig.advance(400);
    assert.equal(rig.cabin.io.display, 'O');
    rig.cabin.button('AB');
    rig.advance(100);
    assert.equal(desired(rig), selected);
    assert.ok(rig.lights.strips[0].pixels.every(color => color === 0x00007f));
});

test('brightness changes while front is off do not turn it on', () => {
    const rig = pair(false, true);
    rig.advance(100);
    rig.cabin.button('AB');
    rig.advance(100);
    rig.cabin.button('B');
    rig.advance(100);
    assert.equal(rig.cabin.io.display, 'O');
    assert.ok(rig.lights.strips[0].pixels.every(color => color === 0));
    rig.cabin.button('AB');
    rig.advance(100);
    assert.ok(rig.lights.strips[0].pixels.every(color => color === 0x7f7f7f));
});

test('cabin commands during rear startup do not cancel or reset rear startup', () => {
    const rig = pair(false, true);
    rig.advance(100);
    rig.cabin.button('A');
    rig.advance(100);
    assert.equal(rig.lights.run('startup'), true);
    assert.ok(rig.lights.strips[0].pixels.every(color => color === 0x3f2a15));
    assert.equal(rig.lights.run('startup_started'), 0);
    rig.advance(2000);
    assert.equal(rig.lights.run('startup'), false);
    assert.ok(rig.lights.strips[0].pixels.every(color => color === 0x3f2a15));
});

test('front animation never retriggers rear indicators or rewrites unchanged rear pixels', () => {
    const rig = pair(false, true);
    rig.advance(2200);
    const rearFrames = rig.lights.strips[1].frames.length;
    for (let i = 0; i < 5; i++) rig.cabin.button('A');
    rig.advance(100);
    const frontFrames = rig.lights.strips[0].frames.length;
    rig.advance(600);
    assert.ok(rig.lights.strips[0].frames.length > frontFrames);
    assert.equal(rig.lights.strips[1].frames.length, rearFrames);
    rig.lights.button('A');
    rig.advance(20);
    const started = rig.lights.run('indicator_started');
    rig.cabin.button('B');
    rig.advance(120);
    assert.equal(rig.lights.run('indicator_started'), started);
    assert.ok(desired(rig) & 8);
});

test('simultaneous rear and cabin commands both apply and acknowledge independently', () => {
    const rig = pair(true, true);
    rig.advance(400);
    rig.controller.button('A');
    rig.cabin.button('A');
    rig.cabin.button('B');
    rig.advance(300);
    assert.equal(desired(rig) & 0x3f, 4 | 8);
    assert.equal(desired(rig) & 0xfc0, (1 << 6) | (1 << 9));
    assert.equal(rig.controller.run('client.pending'), false);
    assert.equal(rig.cabin.run('client.pending'), false);
    assert.equal(rig.lights.run('rear_peer.session'), rig.controller.run('client.session'));
    assert.equal(rig.lights.run('cabin_peer.session'), rig.cabin.run('client.session'));
    const packets = rig.network.history.filter(packet => packet.from === 'lights');
    assert.equal(new Set(packets.map(packet => packet.time)).size, packets.length);
});

test('cabin acknowledgements cannot acknowledge rear requests, even with colliding session IDs', () => {
    const rig = pair(true, true);
    rig.advance(400);
    const sharedSession = rig.controller.run('client.session');
    rig.cabin.run(`client.session = ${sharedSession}; client.sequence = 0`);
    rig.controller.run('client.sequence = 0');
    rig.network.drop = packet => packet.from === 'lights' && packet.data[1] === 3;
    rig.controller.button('A');
    rig.cabin.button('A');
    rig.advance(500);
    assert.equal(rig.cabin.run('client.pending'), false);
    assert.equal(rig.controller.run('client.pending'), true);
    rig.network.drop = () => false;
    rig.advance(300);
    assert.equal(rig.controller.run('client.pending'), false);
});

test('a failed cabin radio request does not block rear commands or rear status', () => {
    const rig = pair(true, true);
    rig.advance(400);
    rig.network.drop = packet => packet.from === 'cabin';
    rig.cabin.button('A');
    rig.controller.button('B');
    rig.advance(2200);
    assert.ok(desired(rig) & 16);
    assert.equal(desired(rig) & 0xfc0, 0);
    assert.equal(rig.cabin.io.sends, 8);
    assert.equal(rig.cabin.io.display, '!');
    assert.equal(rig.controller.run('client.pending'), false);
    assert.equal(rig.controller.run('client.failed'), false);
});

test('restarting the cabin controller cannot retire the rear controller session', () => {
    const rig = pair(true, true);
    rig.advance(400);
    rig.controller.button('A');
    rig.cabin.button('A');
    rig.advance(200);
    const rearSession = rig.lights.run('rear_peer.session');
    rig.restartCabin();
    rig.advance(400);
    rig.cabin.button('B');
    rig.controller.button('B');
    rig.advance(200);
    assert.equal(rig.lights.run('rear_peer.session'), rearSession);
    assert.equal(rig.controller.run('client.pending'), false);
    assert.equal(rig.cabin.run('client.pending'), false);
    assert.ok(desired(rig) & 16);
    assert.equal(rig.lights.run('rear_peer.retired.length'), 0);
});

test('cabin retry after loss or duplication cannot advance mode twice', () => {
    const rig = pair(true, true);
    rig.advance(400);
    let dropped = false;
    rig.network.drop = packet => {
        if (packet.from === 'cabin' && !dropped) { dropped = true; return true; }
        return false;
    };
    rig.cabin.button('A');
    rig.advance(600);
    assert.equal(rig.cabin.io.display, 'Y');
    assert.equal(rig.cabin.run('client.pending'), false);
    const packet = rig.network.history.filter(packet => packet.from === 'cabin').at(-1);
    rig.lights.receive(packet.data);
    rig.advance(20);
    assert.equal(rig.lights.run('BikeRadio.frontMode(desired_state)'), 1);
});

test('a light-board restart retargets pending commands from both scopes', () => {
    const rig = pair(true, true);
    rig.advance(400);
    rig.network.drop = packet => packet.from !== 'lights';
    rig.controller.button('B');
    rig.cabin.button('A');
    rig.advance(100);
    rig.restartLights();
    rig.network.drop = () => false;
    rig.advance(600);
    assert.ok(desired(rig) & 16);
    assert.equal(rig.lights.run('BikeRadio.frontMode(desired_state)'), 1);
    assert.equal(rig.controller.run('client.pending'), false);
    assert.equal(rig.cabin.run('client.pending'), false);
});

test('cross-scope commands and invalid stored front modes are explicitly rejected', () => {
    const rig = pair(false);
    const before = desired(rig);
    rig.lights.receive(command(rig, 1, 4 | (1 << 6)));
    rig.lights.receive(cabinCommand(rig, 1, 4 | (1 << 6)));
    rig.lights.receive(cabinCommand(rig, 1, 6 << 6));
    rig.advance(20);
    assert.equal(desired(rig), before);
    assert.equal(rig.lights.logs.filter(message => message.includes('invalid')).length, 3);
    assert.equal(rig.lights.run('rear_peer.session'), 0);
    assert.equal(rig.lights.run('cabin_peer.session'), 0);
});

test('rear and cabin scoped updates preserve the other scope in either arrival order', () => {
    for (const order of ['rear-first', 'cabin-first']) {
        const rig = pair(false);
        const rear = command(rig, 1, 1 | 32);
        const cabin = cabinCommand(rig, 1, (4 << 6) | (3 << 9));
        const packets = order === 'rear-first' ? [rear, cabin] : [cabin, rear];
        for (const packet of packets) rig.lights.receive(packet);
        rig.advance(20);
        assert.equal(desired(rig), 1 | 32 | (4 << 6) | (3 << 9));
        assert.ok(rig.lights.strips[0].pixels.every(color => color === 0x0000ff));
    }
});

test('invalid packets are rejected explicitly', () => {
    const rig = pair();
    const before = desired(rig);
    rig.lights.receive(new RadioBuffer(2));
    const invalid = command(rig, 1, 7);
    rig.lights.receive(invalid);
    rig.controller.receive(new RadioBuffer(2));
    rig.advance(20);
    assert.equal(desired(rig), before);
    assert.equal(rig.lights.logs.filter(message => message.includes('invalid')).length, 2);
    assert.ok(rig.controller.logs.some(message => message.includes('invalid')));
});

test('shake/forced braking demo is removed from both firmwares', () => {
    for (const root of [lightsRoot, controllerRoot, cabinRoot]) {
        const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
        assert.doesNotMatch(source, /ForceBrake|onGesture|control\.reset/);
    }
});
