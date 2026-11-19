import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { frame, KIND, VIDEO_FLAGS, videoPayload } from '../lib/core/frames.js'

const source = readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8')

test('iOS presents only the latest decoded frame at vsync using a stable intermediate canvas', async () => {
  const callbacks = new Map()
  const decoded = []
  const blits = []
  const scratchCanvases = []
  let nextRaf = 0
  let controller
  const canvas = { width: 300, height: 150, getContext: () => ({
    fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, drawImage() {}
  }) }
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame(callback) { callbacks.set(++nextRaf, callback); return nextRaf },
    cancelAnimationFrame(id) { callbacks.delete(id) },
    fetch: async () => new Response(new ReadableStream({ start(c) { controller = c } })),
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }); scratchCanvases.push(this) }
      getContext(_, options) {
        assert.equal(options.willReadFrequently, undefined)
        return { drawImage: (f, x, y, w, h) => blits.push([f.id, w, h]) }
      }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor({ output }) { this.output = output }
      configure() { this.state = 'configured' }
      decode(chunk) {
        const id = chunk.data[0]
        const f = { id, displayWidth: 1080, displayHeight: 1900 + id, closed: 0, close() { this.closed++ } }
        decoded.push(f)
        this.output(f)
      }
      close() { this.state = 'closed' }
    }
  })
  const engine = createEngine({ canvas, post() {} })
  const send = (...frames) => controller.enqueue(Buffer.concat(frames))
  const video = (id, flags = 0) => frame(KIND.VIDEO, videoPayload(flags, id, Buffer.of(id)))
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const paint = () => {
    assert.equal(callbacks.size, 1)
    const [[id, callback]] = callbacks
    callbacks.delete(id)
    callback()
  }
  engine.handle({ type: 'open', streamUrl: '/video' })
  try {
    send(frame(KIND.META, Buffer.from(JSON.stringify({
      type: 'meta', platform: 'ios', screen: { width: 1080, height: 1920 },
      videoCodec: 'hvc1.test', videoDescription: 'AA=='
    }))), video(1, VIDEO_FLAGS.KEY), video(2), video(3))
    await settle()
    assert.deepEqual(decoded.map((f) => f.closed), [1, 1, 0])
    paint()
    send(video(4))
    await settle()
    paint()
    assert.deepEqual(blits, [[3, 1080, 1920], [4, 1080, 1920]])
    assert.equal(scratchCanvases.length, 1)
    send(video(5))
    await settle()
    assert.equal(callbacks.size, 1)
  } finally {
    engine.handle({ type: 'close' })
    controller.close()
  }
  assert.equal(callbacks.size, 0)
  assert.deepEqual(decoded.map((f) => f.closed), [1, 1, 1, 1, 1])
})
