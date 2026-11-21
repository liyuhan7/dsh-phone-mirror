import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { frame, KIND } from '../lib/core/frames.js'

const source = readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8')

// 重同步语义（引擎直连 sidecar 流）：订阅初期跳过缓存帧之前的增量帧，
// 从第一张关键帧（type=2，reset）起步；解码积压时发 PLI 并只收关键帧，
// 等待解除后的普通关键帧按 reset 关键帧处理。
test('iOS resync starts at a live keyframe and never replays cached video', { timeout: 4000 }, async () => {
  const decoded = []
  const fetchedUrls = []
  let hostController
  let sidecarController
  let backlog = 0
  const canvas = { width: 300, height: 150, getContext: () => ({
    fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, setTransform() {},
    drawImage: (f, x, y, w, h) => blits.push([f.id, w, h])
  }) }
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame() { return 1 }, cancelAnimationFrame() {},
    fetch: async (url, options) => {
      const target = String(url)
      fetchedUrls.push(target)
      if (options?.method === 'POST') return new Response(new Uint8Array())
      const controller = target.endsWith('/stream.bin') ? sidecarController : hostController
      return new Response(new ReadableStream({ start(c) { c.enqueue(controller.pending.shift()) } }))
    },
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }) }
      getContext() { return { drawImage() {} } }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor({ output }) { this.output = output; this.decodeQueueSize = 0 }
      configure() { this.state = 'configured' }
      decode(chunk) {
        const id = chunk.data[0]
        const f = { id, displayWidth: 1080, displayHeight: 1920, closed: 0, close() { this.closed++ } }
        decoded.push(f)
        // 解码完 4 号帧后制造积压，触发 PLI；6 号关键帧入队后积压消退。
        backlog = id === 4 ? 99 : 0
        this.decodeQueueSize = backlog
        this.output(f)
      }
      close() { this.state = 'closed' }
    }
  })
  const engine = createEngine({ canvas, post() {} })
  // fetch 剥掉 chunked 编码后，读到的是 [u32 大端长度][type][AU]。
  const sidecar = (type, value) => {
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(2)
    return Buffer.concat([prefix, Buffer.of(type), Buffer.of(value)])
  }
  const drain = async (want) => {
    for (let i = 0; i < 120 && decoded.length < want; i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  hostController = { pending: [frame(KIND.META, Buffer.from(JSON.stringify({
    type: 'meta', platform: 'ios', screen: { width: 1080, height: 1920 },
    videoCodec: 'hvc1.test', videoDescription: 'AA=='
  })))] }
  sidecarController = { pending: [Buffer.concat([
    sidecar(0, 1), // 订阅前的缓存帧与增量帧全部跳过
    sidecar(1, 2),
    sidecar(2, 3), // 第一张实时关键帧，reset
    sidecar(1, 4),
    sidecar(1, 5), // 积压期间到达的增量帧被 PLI 门控丢弃
    sidecar(0, 6), // 普通关键帧按 reset 关键帧处理
    sidecar(1, 7)
  ])] }
  engine.handle({
    type: 'open', streamUrl: '/video', controlUrl: '/control',
    directVideoUrl: 'http://127.0.0.1:49152/stream.bin'
  })
  try {
    await drain(4)
    // 解码顺序：缓存帧 1/2 与积压期增量 5 被丢弃。
    assert.deepEqual(decoded.map((f) => f.id), [3, 4, 6, 7])
    assert.ok(fetchedUrls.some((url) => url.includes('/control') && url.includes('kind=reset')))
  } finally {
    engine.handle({ type: 'close' })
  }
  assert.ok(decoded.every((f) => f.closed === 1))
})
