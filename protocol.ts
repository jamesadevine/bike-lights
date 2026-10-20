namespace BikeRadio {
    export const GROUP = 99
    export const VERSION = 2
    export const PACKET_LENGTH = 18
    export const MAX_SEQUENCE = 0x3fffffff
    export const REAR_MASK = 0x3f
    export const FRONT_MODE_MASK = 0x1c0
    export const FRONT_LEVEL_MASK = 0x600
    export const FRONT_OFF = 0x800
    export const CABIN_MASK = 0xfc0
    export const DESIRED_MASK = REAR_MASK | CABIN_MASK
    export const LEFT = 0x08
    export const RIGHT = 0x10
    export const NIGHT = 0x20
    export const LEFT_ON = 0x1000
    export const RIGHT_ON = 0x2000
    export const BRAKE_ON = 0x4000

    export enum Domain {
        Rear,
        Cabin
    }

    export enum PacketType {
        RearCommand = 1,
        CabinCommand,
        RearStatus,
        CabinStatus
    }

    export enum Mode {
        Hazards = 1,
        Automatic = 4
    }

    export enum FrontMode {
        White,
        WarmWhite,
        Red,
        Green,
        Blue,
        Rainbow,
        Off
    }

    export enum Action {
        Left,
        Right,
        Night,
        Day,
        Hazards,
        FrontNext,
        FrontBrightness,
        FrontToggle
    }

    export function session(): number {
        return randint(1, MAX_SEQUENCE)
    }

    export function elapsed(now: number, then: number): number {
        return (now - then) >>> 0
    }

    export function validState(state: number): boolean {
        return ((state & 7) == Mode.Automatic || (state & 7) == Mode.Hazards) &&
            (state & (LEFT | RIGHT)) != (LEFT | RIGHT) &&
            ((state & FRONT_MODE_MASK) >> 6) <= FrontMode.Rainbow
    }

    export function frontMode(state: number): FrontMode {
        return (state & FRONT_OFF) != 0 ? FrontMode.Off : (state & FRONT_MODE_MASK) >> 6
    }

    export function domainMask(domain: Domain): number {
        return domain == Domain.Rear ? REAR_MASK : CABIN_MASK
    }

    export function commandType(domain: Domain): PacketType {
        return domain == Domain.Rear ? PacketType.RearCommand : PacketType.CabinCommand
    }

    export function statusType(domain: Domain): PacketType {
        return domain == Domain.Rear ? PacketType.RearStatus : PacketType.CabinStatus
    }

    export function change(state: number, action: Action): number {
        state &= DESIRED_MASK
        switch (action) {
            case Action.Left: return ((state & ~(RIGHT | 7)) | Mode.Automatic) ^ LEFT
            case Action.Right: return ((state & ~(LEFT | 7)) | Mode.Automatic) ^ RIGHT
            case Action.Night: return state | NIGHT
            case Action.Day: return state & ~NIGHT
            case Action.Hazards:
                return (state & ~(LEFT | RIGHT | 7)) |
                    ((state & 7) == Mode.Hazards ? Mode.Automatic : Mode.Hazards)
            case Action.FrontNext:
                if ((state & FRONT_OFF) != 0)
                    return state & ~(FRONT_OFF | FRONT_MODE_MASK)
                if (frontMode(state) == FrontMode.Rainbow)
                    return state | FRONT_OFF
                return state + (1 << 6)
            case Action.FrontBrightness:
                return (state & ~FRONT_LEVEL_MASK) |
                    (((((state & FRONT_LEVEL_MASK) >> 9) + 1) % 4) << 9)
            case Action.FrontToggle:
                return state ^ FRONT_OFF
        }
        return state
    }

    // All three apps carry this file; integration tests check they stay identical.
    export function packet(type: PacketType, lights: number, controller: number,
        sequence: number, state: number, revision: number): Buffer {
        const data = pins.createBuffer(PACKET_LENGTH)
        data[0] = VERSION
        data[1] = type
        data.setNumber(NumberFormat.UInt32LE, 2, lights)
        data.setNumber(NumberFormat.UInt32LE, 6, controller)
        data.setNumber(NumberFormat.UInt32LE, 10, sequence)
        data.setNumber(NumberFormat.UInt16LE, 14, state)
        data.setNumber(NumberFormat.UInt16LE, 16, revision)
        return data
    }

    export function validPacket(data: Buffer, type: PacketType): boolean {
        if (data.length != PACKET_LENGTH || data[0] != VERSION || data[1] != type)
            return false
        const lights = data.getNumber(NumberFormat.UInt32LE, 2)
        const controller = data.getNumber(NumberFormat.UInt32LE, 6)
        const sequence = data.getNumber(NumberFormat.UInt32LE, 10)
        const state = data.getNumber(NumberFormat.UInt16LE, 14)
        if (lights < 1 || lights > MAX_SEQUENCE || controller > MAX_SEQUENCE ||
            sequence > MAX_SEQUENCE)
            return false
        if (type == PacketType.RearCommand || type == PacketType.CabinCommand) {
            const rear = type == PacketType.RearCommand
            const mask = rear ? REAR_MASK : CABIN_MASK
            const complete = rear ? state : state | Mode.Automatic
            return controller > 0 && sequence > 0 && (state & ~mask) == 0 &&
                validState(complete) &&
                data.getNumber(NumberFormat.UInt16LE, 16) == 0
        }
        return (type == PacketType.RearStatus || type == PacketType.CabinStatus) &&
            (state & ~0x7fff) == 0 && validState(state) &&
            ((controller == 0 && sequence == 0) || (controller > 0 && sequence > 0))
    }
}
