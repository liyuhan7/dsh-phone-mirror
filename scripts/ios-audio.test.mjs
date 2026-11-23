import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { AUDIO_FLAGS, frame, KIND, videoPayload } from '../lib/core/frames.js'

const source = readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8')

// iOS 音频直连 sidecar：宿主事件循环被主对话占住时，经宿主中转的 PCM 会成串
// 迟到。引擎改为自己订阅 sidecar 的 /audio.bin，宿主转发的同一路音频丢弃。
const harness = ({ audioResponse } = {}) => {
  const streams = {}
  const fetched = []
  const posted = []
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame() { return 1 }, cancelAnimationFrame() {},
    fetch: async (url, options) => {
      const target = String(url)
      fetched.push(target)
      if (options?.method === 'POST') return new Response('{"ok":true}')
      if (target.endsWith('/codec')) {
        return new Response(JSON.stringify({ display: { width: 1080, height: 1920, rotation: 0 } }))
      }
      if (target.endsWith('/audio.bin') && audioResponse) return audioResponse
      const key = target.endsWith('/audio.bin') ? 'audio' : target.endsWith('/stream.bin') ? 'direct' : 'host'
      return new Response(new ReadableStream({ start(controller) { streams[key] = controller } }))
    },
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }) }
      getContext() { return { drawImage() {} } }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor({ output }) { this.output = output }
      configure() { this.state = 'configured' }
      decode(chunk) { this.output({ id: chunk.data[0], displayWidth: 1080, displayHeight: 1920, close() {} }) }
      close() { this.state = 'closed' }
    }
  })
  const canvas = { width: 300, height: 150, getContext: () => ({ fillRect() {} }) }
  const engine = createEngine({ canvas, post: (message) => posted.push(message) })
  const port = {
    posted: [],
    onmessage: null,
    postMessage(message) { this.posted.push(message) }
  }
  return { engine, streams, fetched, posted, port }
}

const pcmFrame = (samples) => {
  const body = Buffer.alloc(samples.length * 4)
  samples.forEach(([left, right], index) => {
    body.writeInt16LE(left, index * 4)
    body.writeInt16LE(right, index * 4 + 2)
  })
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(body.length)
  return Buffer.concat([prefix, body])
}

const hostPcm = (value) => {
  const body = Buffer.alloc(4)
  body.writeInt16LE(value, 0)
  body.writeInt16LE(value, 2)
  return frame(KIND.AUDIO, videoPayload(AUDIO_FLAGS.PCM, 0, body))
}

const until = async (predicate, timeout = 1000) => {
  for (let waited = 0; waited < timeout; waited += 5) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时')
}

test('iOS audio subscribes to the sidecar and drops the host relay copy', { timeout: 4000 }, async () => {
  const { engine, streams, fetched, port } = harness()
  engine.handle({ type: 'audio-port', port })
  engine.handle({
    type: 'open', streamUrl: '/video', controlUrl: '/control',
    directVideoUrl: 'http://127.0.0.1:49152/stream.bin'
  })
  try {
    await until(() => streams.host)
    // 宿主 meta 报告本会话有音频后，引擎才直连订阅 /audio.bin。
    streams.host.enqueue(frame(KIND.META, Buffer.from(JSON.stringify({
      type: 'meta', platform: 'ios', audio: true, screen: { width: 1290, height: 2796 }
    }))))
    await until(() => streams.audio)
    assert.ok(fetched.includes('http://127.0.0.1:49152/audio.bin'))
    streams.audio.enqueue(pcmFrame([[16384, -16384], [8192, 0]]))
    await until(() => port.posted.some((message) => message.type === 'pcm'))
    const pcm = port.posted.find((message) => message.type === 'pcm')
    assert.deepEqual(Array.from(pcm.left), [0.5, 0.25])
    assert.deepEqual(Array.from(pcm.right), [-0.5, 0])
    // 宿主转发的同一路音频不再进 worklet，否则会双份播放。
    const before = port.posted.filter((message) => message.type === 'pcm').length
    streams.host.enqueue(hostPcm(1000))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(port.posted.filter((message) => message.type === 'pcm').length, before)
  } finally {
    engine.handle({ type: 'close' })
  }
})

test('sidecar audio refusal falls back to the host relay', { timeout: 4000 }, async () => {
  const { engine, streams, fetched, port } = harness({ audioResponse: new Response('audio disabled', { status: 503 }) })
  engine.handle({ type: 'audio-port', port })
  engine.handle({
    type: 'open', streamUrl: '/video', controlUrl: '/control',
    directVideoUrl: 'http://127.0.0.1:49152/stream.bin'
  })
  try {
    await until(() => streams.host)
    streams.host.enqueue(frame(KIND.META, Buffer.from(JSON.stringify({
      type: 'meta', platform: 'ios', audio: true, screen: { width: 1290, height: 2796 }
    }))))
    await until(() => fetched.some((url) => url.includes('kind=audio-relay&on=1')))
    streams.host.enqueue(hostPcm(1000))
    await until(() => port.posted.some((message) => message.type === 'pcm'))
    const pcm = port.posted.find((message) => message.type === 'pcm')
    assert.equal(pcm.left[0], 1000 / 32768)
  } finally {
    engine.handle({ type: 'close' })
  }
})

test('audio-worklet crossfades catch-up drops instead of hard-jumping samples', () => {
  const workletSource = readFileSync(new URL('../lib/audio-worklet.js', import.meta.url), 'utf8')
  let Processor
  runInNewContext(workletSource, {
    sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage() {} } } },
    registerProcessor(_name, cls) { Processor = cls }
  })
  const sink = new Processor({ processorOptions: { targetMs: 80 } })
  // 忽略非法 targetMs，防止 NaN 破坏缓冲状态。
  sink.port.onmessage({ data: { type: 'target', ms: NaN } })
  assert.equal(sink.target, 3840)

  // 先缓冲到进入播放态，再制造超过 400ms 的积压触发追帧丢样。
  const ones = new Float32Array(19200).fill(1)
  const zeros = new Float32Array(19200).fill(0)
  sink.push(ones, ones)
  const out = [new Float32Array(128), new Float32Array(128)]
  sink.process([], [out])
  assert.equal(sink.playing, true)

  sink.push(zeros, zeros)
  // 丢样起点紧接旧样本（1.0），经过 5ms 交叉淡化平稳过渡到新样本（0.0），不硬跳。
  assert.ok(sink.left[sink.read] > 0.9, `expected smooth fade-out from ~1.0, got ${sink.left[sink.read]}`)
  const endFadeSlot = (sink.read + sink.fade - 1) % sink.capacity
  assert.equal(sink.left[endFadeSlot], 0)
})
