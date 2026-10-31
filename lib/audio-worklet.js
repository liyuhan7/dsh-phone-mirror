// 音频环形缓冲（AudioWorklet）。主线程把解码好的 PCM 塞进来，
// 这里按音频时钟取数：缓冲攒够 target 才出声，欠载补静音并上报。
// 这个文件由宿主按 /dsh-phone-mirror/audio-worklet.js 原样提供，不参与打包。

class PcmSink extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.rate = sampleRate
    // 4 秒容量足够覆盖主线程长卡顿，超出部分由目标缓冲控制延迟。
    this.capacity = Math.floor(this.rate * 4)
    this.left = new Float32Array(this.capacity)
    this.right = new Float32Array(this.capacity)
    this.read = 0
    this.write = 0
    this.size = 0
    this.playing = false
    const targetMs = options?.processorOptions?.targetMs ?? 80
    this.target = Math.floor((this.rate * targetMs) / 1000)
    this.port.onmessage = (event) => {
      const message = event.data
      if (message?.type === 'target') {
        this.target = Math.max(1, Math.floor((this.rate * message.ms) / 1000))
      } else if (message?.type === 'pcm') {
        this.push(message.left, message.right)
      } else if (message?.type === 'reset') {
        this.read = 0
        this.write = 0
        this.size = 0
        this.playing = false
      }
    }
  }

  push(left, right) {
    const frames = left.length
    if (frames === 0 || frames >= this.capacity) return
    // 积压超过目标缓冲的两倍就丢掉最旧的，避免延迟越滚越大。
    const limit = this.target * 2
    if (this.size + frames > limit) this.drop(this.size + frames - limit)
    if (this.size + frames > this.capacity) this.drop(this.size + frames - this.capacity)
    for (let index = 0; index < frames; index += 1) {
      const slot = (this.write + index) % this.capacity
      this.left[slot] = left[index]
      this.right[slot] = right === undefined ? left[index] : right[index]
    }
    this.write = (this.write + frames) % this.capacity
    this.size += frames
  }

  drop(frames) {
    const count = Math.min(frames, this.size)
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
    }
    for (let index = 0; index < frames; index += 1) {
      if (this.size === 0) {
        this.playing = false
        this.port.postMessage({ type: 'underrun' })
        this.silence(output, index, frames)
        return true
      }
      const slot = this.read
      output[0][index] = this.left[slot]
      if (output[1] !== undefined) output[1][index] = this.right[slot]
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
