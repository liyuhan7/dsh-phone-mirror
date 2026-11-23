// 音频环形缓冲（AudioWorklet）。主线程把解码好的 PCM 塞进来，
// 这里按音频时钟取数：缓冲攒够 target 才出声，欠载补静音并上报。
// 这个文件由宿主按 /dsh-phone-mirror/audio-worklet.js 原样提供，不参与打包。

class PcmSink extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.rate = sampleRate
    // 环形缓冲容量 4 秒。
    this.capacity = Math.floor(this.rate * 4)
    this.left = new Float32Array(this.capacity)
    this.right = new Float32Array(this.capacity)
    this.read = 0
    this.write = 0
    this.size = 0
    this.playing = false
    // 欠载/恢复时用 5 ms 淡出淡入，避免波形被硬切出「哒」声。
    this.fade = Math.max(1, Math.floor(this.rate * 0.005))
    this.gain = 1
    this.lastLeft = 0
    this.lastRight = 0
    const targetMs = options?.processorOptions?.targetMs ?? 80
    this.target = Math.floor((this.rate * targetMs) / 1000)
    this.port.onmessage = (event) => {
      const message = event.data
      if (message?.type === 'target') {
        if (Number.isFinite(message.ms)) {
          this.target = Math.max(1, Math.floor((this.rate * message.ms) / 1000))
        }
      } else if (message?.type === 'pcm') {
        this.push(message.left, message.right)
      } else if (message?.type === 'reset') {
        this.read = 0
        this.write = 0
        this.size = 0
        this.playing = false
        this.gain = 1
        this.lastLeft = 0
        this.lastRight = 0
      }
    }
  }

  push(left, right) {
    const frames = left.length
    if (frames === 0 || frames >= this.capacity) return
    if (this.size + frames > this.capacity) this.drop(this.size + frames - this.capacity)
    for (let index = 0; index < frames; index += 1) {
      const slot = (this.write + index) % this.capacity
      this.left[slot] = left[index]
      this.right[slot] = right === undefined ? left[index] : right[index]
    }
    this.write = (this.write + frames) % this.capacity
    this.size += frames
    // 给足缓冲余量，写入后再追帧丢样，确保交叉淡化直接作用于新样本。
    const limit = Math.max(this.target * 3, Math.floor(this.rate * 0.4))
    if (this.size > limit) this.drop(this.size - limit)
  }

  drop(frames) {
    const count = Math.min(frames, this.size)
    // 播放中追帧丢样时在跳点做 5 ms 交叉淡化，消除波形跳变的噗啪声。
    if (this.playing && this.size - count >= this.fade && count >= this.fade) {
      const oldRead = this.read
      const newRead = (this.read + count) % this.capacity
      for (let i = 0; i < this.fade; i += 1) {
        const t = (i + 1) / this.fade
        const a = (oldRead + i) % this.capacity
        const b = (newRead + i) % this.capacity
        this.left[b] = this.left[a] * (1 - t) + this.left[b] * t
        this.right[b] = this.right[a] * (1 - t) + this.right[b] * t
      }
    }
    this.read = (this.read + count) % this.capacity
    this.size -= count
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (output === undefined || output.length === 0) return true
    const frames = output[0].length
    if (!this.playing) {
      if (this.size < this.target) {
        this.silence(output, 0, frames)
        return true
      }
      this.playing = true
      this.gain = 0
    }
    for (let index = 0; index < frames; index += 1) {
      if (this.size === 0) {
        for (let rest = index; rest < frames; rest += 1) {
          this.gain = Math.max(0, this.gain - 1 / this.fade)
          output[0][rest] = this.lastLeft * this.gain
          if (output[1] !== undefined) output[1][rest] = this.lastRight * this.gain
        }
        this.playing = false
        this.port.postMessage({ type: 'underrun' })
        return true
      }
      const slot = this.read
      this.lastLeft = this.left[slot]
      this.lastRight = this.right[slot]
      if (this.gain < 1) this.gain = Math.min(1, this.gain + 1 / this.fade)
      output[0][index] = this.lastLeft * this.gain
      if (output[1] !== undefined) output[1][index] = this.lastRight * this.gain
      this.read = (this.read + 1) % this.capacity
      this.size -= 1
    }
    return true
  }

  silence(output, from, frames) {
    for (let channel = 0; channel < output.length; channel += 1) {
      output[channel].fill(0, from, frames)
    }
  }
}

registerProcessor('dsh-pcm-sink', PcmSink)
