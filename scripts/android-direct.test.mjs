import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { AUDIO_FLAGS, frame, KIND, metaPayload, VIDEO_FLAGS, videoPayload } from '../lib/core/frames.js'
import { createDirectBridge } from '../lib/providers/android/direct-worker.js'

const engineSource = readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8')

class FakeScrcpySession extends EventEmitter {
  constructor() {
    super()
    this.deviceName = 'Pixel 9'
    this.screen = { width: 1080, height: 2400 }
    this.audioCodec = 'opus'
    this.videoCodec = 'h264'
    this.sent = []
    this.stopped = false
  }

  async start() {}

  send(buffer) {
    this.sent.push(buffer)
    return true
  }

  async stop() {
    this.stopped = true
    this.emit('close')
  }
}

function parseFrames(buffer) {
  const out = []
  let offset = 0
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32BE(offset)
    if (buffer.length - offset < 4 + length) break
    out.push({ kind: buffer[offset + 4], payload: buffer.subarray(offset + 5, offset + 4 + length) })
    offset += 4 + length
  }
  return out
}

test('android direct bridge streams frames, replays cached configs to new subscribers, and handles /control + /reset', async () => {
  const session = new FakeScrcpySession()
  const events = []
  const bridge = createDirectBridge({ session, onEvent: (e) => events.push(e) })
  const info = await bridge.start()
  assert.ok(info.videoPort > 0)
  const base = `http://127.0.0.1:${info.videoPort}`

  try {
    // 先产出配置包再订阅，验证后接入订阅端能收到缓存的 SPS/PPS 与 OpusHead。
    const spsPps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xe0, 0x1f, 0x00, 0x00, 0x00, 0x01, 0x68, 0xce])
    const opusHead = Buffer.from('OpusHead\x01\x02\x38\x01\x80\xbb\x00\x00\x00\x00\x00', 'latin1')
    session.emit('video', { data: spsPps, pts: 0, config: true, key: false })
    session.emit('audio', { data: opusHead, pts: 0, config: true })

    // 拒绝非回环 Origin，放行本机 Origin 并回显 ACAO。
    const denied = await fetch(`${base}/reset`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' }
    })
    assert.equal(denied.status, 403)

    const ac = new AbortController()
    const streamRes = await fetch(`${base}/frames.bin`, {
      signal: ac.signal,
      headers: { origin: 'http://127.0.0.1:43120' }
    })
    assert.equal(streamRes.status, 200)
    assert.equal(streamRes.headers.get('access-control-allow-origin'), 'http://127.0.0.1:43120')

    // 订阅即请求编码器发关键帧（control.resetVideo() 首字节为 17）。
    assert.ok(session.sent.some((buf) => buf[0] === 17))

    // 推一帧关键帧视频和一帧音频。
    const idr = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84])
    const opusPacket = Buffer.from([0xf8, 0xff, 0xfe])
    session.emit('video', { data: idr, pts: 1000, config: false, key: true })
    session.emit('audio', { data: opusPacket, pts: 1000, config: false })

    const reader = streamRes.body.getReader()
    let collected = Buffer.alloc(0)
    let frames = []
    for (let i = 0; i < 20 && frames.length < 5; i += 1) {
      const { done, value } = await reader.read()
      if (done) break
      collected = Buffer.concat([collected, Buffer.from(value)])
      frames = parseFrames(collected)
    }
    ac.abort()

    assert.equal(frames[0].kind, KIND.META)
    const meta = JSON.parse(frames[0].payload.toString('utf8'))
    assert.equal(meta.platform, 'android')
    assert.equal(meta.deviceName, 'Pixel 9')
    assert.deepEqual(meta.screen, { width: 1080, height: 2400 })

    // 缓存的配置包 + 实时关键帧与音频包都已直连送达。
    const videos = frames.filter((f) => f.kind === KIND.VIDEO)
    const audios = frames.filter((f) => f.kind === KIND.AUDIO)
    assert.equal(videos.length, 2)
    assert.equal(videos[0].payload[0] & VIDEO_FLAGS.CONFIG, VIDEO_FLAGS.CONFIG)
    assert.equal(videos[1].payload[0] & VIDEO_FLAGS.KEY, VIDEO_FLAGS.KEY)
    assert.equal(audios.length, 2)
    assert.equal(audios[0].payload[0] & AUDIO_FLAGS.CONFIG, AUDIO_FLAGS.CONFIG)
    assert.equal(audios[1].payload[0] & AUDIO_FLAGS.CONFIG, 0)

    // 控制指令以 text/plain 直连 /control（免 CORS 预检）并写入控制 socket。
    const before = session.sent.length
    const ctrlRes = await fetch(`${base}/control`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://127.0.0.1:43120' },
      body: JSON.stringify({ kind: 'touch', action: 'down', x: 0.5, y: 0.5 })
    })
    assert.equal(ctrlRes.status, 200)
    assert.deepEqual(await ctrlRes.json(), { ok: true })
    assert.equal(session.sent.length, before + 1)
    assert.equal(session.sent.at(-1)[0], 2) // TYPE_INJECT_TOUCH_EVENT
  } finally {
    await bridge.stop()
  }
  assert.equal(session.stopped, true)
  assert.ok(events.some((e) => e.type === 'close'))
})

test('engine auto-heals Android videoPort to /frames.bin, decodes video directly, and posts /reset', async () => {
  const fetched = []
  const written = []
  const messages = []
  let hostSentCount = 0
  let directSent = false

  const spsPps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xe0, 0x1f, 0x00, 0x00, 0x00, 0x01, 0x68, 0xce])
  const idr = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0xaa, 0xbb])
  const canvas = { width: 300, height: 150, getContext: () => ({ fillRect() {}, setTransform() {}, drawImage() {} }) }

  const createEngine = runInNewContext(`${engineSource}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame() { return 1 }, cancelAnimationFrame() {},
    fetch: async (url, opts) => {
      const target = String(url)
      fetched.push(`${opts?.method ?? 'GET'} ${target}`)
      if (target.endsWith('/reset')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (target.endsWith('/frames.bin')) {
        return new Response(new ReadableStream({
          start(c) {
            if (directSent) return
            directSent = true
            c.enqueue(Buffer.concat([
              frame(KIND.META, metaPayload({ type: 'meta', platform: 'android', screen: { width: 1080, height: 2400 } })),
              frame(KIND.VIDEO, videoPayload(VIDEO_FLAGS.CONFIG, 0, spsPps)),
              frame(KIND.VIDEO, videoPayload(VIDEO_FLAGS.KEY, 1000, idr))
            ]))
          }
        }))
      }
      return new Response(new ReadableStream({
        start(c) {
          hostSentCount += 1
          c.enqueue(frame(KIND.META, metaPayload({
            type: 'meta',
            platform: 'android',
            state: 'running',
            screen: { width: 1080, height: 2400 },
            videoPort: 51234
          })))
        }
      }))
    },
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }) }
      getContext() { return { clearRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8Array(32 * 72 * 4).fill(255) }) } }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor({ output }) { this.output = output; this.decodeQueueSize = 0 }
      configure() { this.state = 'configured' }
      decode() {
        this.output({ displayWidth: 1080, displayHeight: 2400, close() {} })
      }
      close() { this.state = 'closed' }
    }
  })

  const engine = createEngine({ canvas, post: (m) => messages.push(m) })
  engine.handle({
    type: 'video-writable',
    writable: {
      getWriter: () => ({
        desiredSize: 2,
        ready: Promise.resolve(),
        write: (f) => { written.push([f.displayWidth, f.displayHeight]); return Promise.resolve() }
      })
    }
  })
  // 故意不传 directVideoUrl，验证引擎从宿主 meta 的 videoPort 自动补全安卓 /frames.bin 地址。
  engine.handle({ type: 'open', streamUrl: '/api/stream', controlUrl: '/api/control' })
  try {
    for (let i = 0; i < 60 && written.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(hostSentCount >= 2, '补全 videoPort 后应重连以启用直连流')
    assert.ok(fetched.includes('GET http://127.0.0.1:51234/frames.bin'))
    assert.deepEqual(written, [[1080, 2400]])
    assert.ok(messages.some((m) => m.type === 'render-mode' && m.mode === 'video'))
    assert.ok(messages.some((m) => m.type === 'geometry' && m.width === 1080 && m.height === 2400 && m.rotation === 0))
  } finally {
    engine.handle({ type: 'close' })
  }
})
