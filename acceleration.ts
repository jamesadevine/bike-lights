const ACCELERATION_BASELINE_SAMPLES = 50
const ACCELERATION_BASELINE_SPREAD = 80
const DIRECTION_MIN_ACCELERATION = 60
const DIRECTION_LEARNING_INTERVAL = 600
const DIRECTION_MAX_SAMPLE_GAP = 100
const DIRECTION_MIN_ALIGNMENT = 0.95

enum AccelerationCalibrationState {
    Stationary,
    Direction,
    Ready
}

class AccelerationMapper {
    state = AccelerationCalibrationState.Stationary
    baseline: number[]
    direction: number[]
    private gravity: number[]
    private sums: number[]
    private minima: number[]
    private maxima: number[]
    private samples = 0
    private direction_sum: number[]
    private direction_samples = 0
    private direction_started = 0
    private last_sample = 0

    constructor() {
        this.reset()
    }

    reset() {
        this.state = AccelerationCalibrationState.Stationary
        this.baseline = [0, 0, 0]
        this.direction = [0, 0, 0]
        this.gravity = [0, 0, 0]
        this.clearBaseline()
        this.clearDirection()
        console.log("Brake calibration: keep the mounted bike stationary")
    }

    private clearBaseline() {
        this.sums = [0, 0, 0]
        this.minima = [2048, 2048, 2048]
        this.maxima = [-2048, -2048, -2048]
        this.samples = 0
    }

    private clearDirection() {
        this.direction_sum = [0, 0, 0]
        this.direction_samples = 0
        this.direction_started = 0
    }

    private magnitude(vector: number[]): number {
        return Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1] +
            vector[2] * vector[2])
    }

    private dot(a: number[], b: number[]): number {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    }

    sample(x: number, y: number, z: number, now: number): number {
        const values = [x, y, z]
        if (this.state == AccelerationCalibrationState.Stationary) {
            for (let i = 0; i < 3; i++) {
                this.sums[i] += values[i]
                this.minima[i] = Math.min(this.minima[i], values[i])
                this.maxima[i] = Math.max(this.maxima[i], values[i])
            }
            this.samples++
            if (this.samples < ACCELERATION_BASELINE_SAMPLES)
                return 0
            let stable = true
            for (let i = 0; i < 3; i++) {
                this.baseline[i] = this.sums[i] / this.samples
                if (this.maxima[i] - this.minima[i] > ACCELERATION_BASELINE_SPREAD)
                    stable = false
            }
            const magnitude = this.magnitude(this.baseline)
            if (!stable || magnitude < 800 || magnitude > 1200) {
                console.log("Brake calibration: keep the mounted bike stationary")
                this.clearBaseline()
                return 0
            }
            for (let i = 0; i < 3; i++)
                this.gravity[i] = this.baseline[i] / magnitude
            this.state = AccelerationCalibrationState.Direction
            this.last_sample = now
            console.log("Brake calibration: waiting for a straight forward pull-away")
            return 0
        }

        const delta = [x - this.baseline[0], y - this.baseline[1], z - this.baseline[2]]
        // The learned pull-away direction is negative braking acceleration.
        if (this.state == AccelerationCalibrationState.Ready)
            return -this.dot(delta, this.direction)

        const vertical = this.dot(delta, this.gravity)
        const horizontal = [delta[0] - vertical * this.gravity[0],
            delta[1] - vertical * this.gravity[1], delta[2] - vertical * this.gravity[2]]
        const magnitude = this.magnitude(horizontal)
        if (((now - this.last_sample) >>> 0) > DIRECTION_MAX_SAMPLE_GAP)
            this.clearDirection()
        this.last_sample = now
        if (magnitude < DIRECTION_MIN_ACCELERATION || Math.abs(vertical) > magnitude / 2) {
            this.clearDirection()
            return 0
        }
        if (this.direction_samples > 0) {
            const alignment = this.dot(horizontal, this.direction_sum) /
                (magnitude * this.magnitude(this.direction_sum))
            if (alignment < DIRECTION_MIN_ALIGNMENT)
                this.clearDirection()
        }
        if (this.direction_samples == 0)
            this.direction_started = now
        for (let i = 0; i < 3; i++)
            this.direction_sum[i] += horizontal[i] / magnitude
        this.direction_samples++
        if (((now - this.direction_started) >>> 0) >= DIRECTION_LEARNING_INTERVAL) {
            const length = this.magnitude(this.direction_sum)
            for (let i = 0; i < 3; i++)
                this.direction[i] = this.direction_sum[i] / length
            this.state = AccelerationCalibrationState.Ready
            console.log("Brake calibration ready, forward axis: " + this.direction)
        }
        return 0
    }
}
