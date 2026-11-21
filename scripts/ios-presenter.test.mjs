import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { frame, KIND, VIDEO_FLAGS, videoPayload } from '../lib/core/frames.js'

const source = readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8')

test('iOS presents decoded frames in order and bounds the queue', async () => {
  const callbacks = new Map()
  const decoded = []
  const blits = []
  const scratchCanvases = []
  let nextRaf = 0
  let controller
  const canvas = { width: 300, height: 150, getContext: () => ({
    fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, setTransform() {},
    drawImage: (f, x, y, w, h) => blits.push([f.id, w, h])
  }) }
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    // 模拟主线程运行：Window 存在时呈现走 rAF。
    Window: class {},
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
  const lastBlit = () => blits[blits.length - 1]
  engine.handle({ type: 'open', streamUrl: '/video' })
  try {
    send(frame(KIND.META, Buffer.from(JSON.stringify({
      type: 'meta', platform: 'ios', screen: { width: 1080, height: 1920 },
      videoCodec: 'hvc1.test', videoDescription: 'AA=='
    }))), video(1, VIDEO_FLAGS.KEY), video(2), video(3))
    await settle()
    // 三帧都留在队列里，没有被丢。
    assert.deepEqual(decoded.map((f) => f.closed), [0, 0, 0])
    paint()
    assert.deepEqual(lastBlit(), [1, 1080, 1920])
    assert.equal(decoded[0].closed, 1)
    paint()
    assert.deepEqual(lastBlit(), [2, 1080, 1920])
    paint()
    assert.deepEqual(lastBlit(), [3, 1080, 1920])
    assert.equal(callbacks.size, 0)
    // 连发六帧：队列上限 4，最旧的两帧被丢。
    send(video(4), video(5), video(6), video(7), video(8), video(9))
    await settle()
    assert.deepEqual(decoded.slice(3).map((f) => f.closed), [1, 1, 0, 0, 0, 0])
    for (const id of [6, 7, 8, 9]) {
      paint()
      assert.deepEqual(lastBlit(), [id, 1080, 1920])
    }
    assert.equal(callbacks.size, 0)
    send(video(10))
    await settle()
    assert.equal(callbacks.size, 1)
  } finally {
    engine.handle({ type: 'close' })
    controller.close()
  }
  assert.equal(callbacks.size, 0)
  assert.ok(decoded.every((f) => f.closed === 1))
  // 无旋转时不经过中转画布，直接合成到可见画布。
  assert.equal(scratchCanvases.length, 0)
})

test('worker presentation drains the queue without rAF', async () => {
  const decoded = []
  const blits = []
  const rafUsed = []
  let controller
  const canvas = { width: 300, height: 150, getContext: () => ({
    fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, setTransform() {},
    drawImage: (f, x, y, w, h) => blits.push([f.id, w, h])
  }) }
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame(callback) { rafUsed.push(callback); return rafUsed.length },
    cancelAnimationFrame() {},
    fetch: async () => new Response(new ReadableStream({ start(c) { controller = c } })),
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }) }
      getContext() { return { drawImage: (f, x, y, w, h) => blits.push([f.id, w, h]) } }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor({ output }) { this.output = output }
      configure() { this.state = 'configured' }
      decode(chunk) {
        const id = chunk.data[0]
        const f = { id, displayWidth: 1080, displayHeight: 1920, closed: 0, close() { this.closed++ } }
        decoded.push(f)
        this.output(f)
      }
      close() { this.state = 'closed' }
    }
  })
  const engine = createEngine({ canvas, post() {} })
  const send = (...frames) => controller.enqueue(Buffer.concat(frames))
  const video = (id, flags = 0) => frame(KIND.VIDEO, videoPayload(flags, id, Buffer.of(id)))
  engine.handle({ type: 'open', streamUrl: '/video' })
  try {
    send(frame(KIND.META, Buffer.from(JSON.stringify({
      type: 'meta', platform: 'ios', screen: { width: 1080, height: 1920 },
      videoCodec: 'hvc1.test', videoDescription: 'AA=='
    }))), video(1, VIDEO_FLAGS.KEY), video(2), video(3))
    // 呈现走定时器链：轮询到三帧画完为止，时长随负载浮动。
    for (let i = 0; i < 80 && blits.length < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    // Worker 里没有 Window：呈现走定时器排空，rAF 完全不被使用。
    assert.equal(rafUsed.length, 0)
    assert.equal(blits.length, 3)
    assert.deepEqual(blits.map((b) => b[0]), [1, 2, 3])
    assert.ok(decoded.every((f) => f.closed === 1))
  } finally {
    engine.handle({ type: 'close' })
    controller.close()
  }
})

test('direct sidecar stream bypasses the host relay', async () => {
  const decoded = []
  const blits = []
  const fetchedUrls = []
  let hostController
  let sidecarController
  const canvas = { width: 300, height: 150, getContext: () => ({
    fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, setTransform() {},
    drawImage: (f, x, y, w, h) => blits.push([f.id, w, h])
  }) }
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    // Worker 语境：无 Window，呈现走定时器。
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame() { return 1 }, cancelAnimationFrame() {},
    fetch: async (url) => {
      fetchedUrls.push(url)
      const target = String(url)
      if (target.endsWith('/codec')) {
        return new Response(JSON.stringify({ display: { width: 1080, height: 1920, rotation: 0 } }))
      }
      const holder = target.endsWith('/stream.bin') ? sidecarController : hostController
      return new Response(new ReadableStream({ start(c) { if (holder) c.enqueue(holder.pending.shift()) } }))
    },
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }) }
      getContext() { return { drawImage: (f, x, y, w, h) => blits.push([f.id, w, h]) } }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor({ output }) { this.output = output }
      configure() { this.state = 'configured' }
      decode(chunk) {
        const id = chunk.data[0]
        const f = { id, displayWidth: 1080, displayHeight: 1920, closed: 0, close() { this.closed++ } }
        decoded.push(f)
        this.output(f)
      }
      close() { this.state = 'closed' }
    }
  })
  const engine = createEngine({ canvas, post() {} })
  // fetch 剥掉 chunked 编码后，读到的是 [u32 大端长度][type][AU] 连续流。
  const sidecar = (type, body) => {
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(body.length + 1)
    return Buffer.concat([prefix, Buffer.of(type), body])
  }
  const drain = async () => {
    // 呈现走定时器链，排空时长随负载浮动：轮询到队列清空为止。
    for (let i = 0; i < 80 && blits.length < 4; i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  // 控制器要先就位：open 会立刻发起两条 fetch。
  hostController = { pending: [frame(KIND.META, Buffer.from(JSON.stringify({
    type: 'meta', platform: 'ios', screen: { width: 1080, height: 1920 },
    videoCodec: 'hvc1.test', videoDescription: 'AA=='
  })))] }
  sidecarController = { pending: [Buffer.concat([
    // 订阅初期先到的增量帧被跳过，等待缓存关键帧（type=2）。
    sidecar(1, Buffer.of(200)),
    sidecar(3, Buffer.from(JSON.stringify({ codec: 'hvc1.ignored' }))),
    sidecar(2, Buffer.of(101)),
    sidecar(1, Buffer.of(102)),
    sidecar(0, Buffer.of(103)),
    sidecar(1, Buffer.of(104))
  ])] }
  engine.handle({
    type: 'open', streamUrl: '/video',
    directVideoUrl: 'http://127.0.0.1:49152/stream.bin'
  })
  try {
    await drain()
    assert.deepEqual(fetchedUrls.sort(), [
      '/video',
      'http://127.0.0.1:49152/codec',
      'http://127.0.0.1:49152/stream.bin'
    ])
    // 增量前的 200 与配置帧被丢弃，解码顺序为缓存关键帧起的三帧。
    assert.deepEqual(decoded.map((f) => f.id), [101, 102, 103, 104])
    assert.equal(blits.length, 4)
  } finally {
    engine.handle({ type: 'close' })
  }
})

test('canvas backing follows the panel size while geometry stays in device pixels', async () => {
  const blits = []
  const geometry = []
  let controller
  const canvas = { width: 0, height: 0, getContext: () => ({
    fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, setTransform() {},
    drawImage: (f, x, y, w, h) => blits.push([w, h])
  }) }
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame() { return 1 }, cancelAnimationFrame() {},
    fetch: async () => new Response(new ReadableStream({ start(c) { controller = c } })),
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }) }
      getContext() { return { drawImage() {} } }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor({ output }) { this.output = output }
      configure() { this.state = 'configured' }
      decode(chunk) { this.output({ displayWidth: 1290, displayHeight: 2796, closed: 0, close() {} }) }
      close() { this.state = 'closed' }
    }
  })
  const engine = createEngine({
    canvas,
    post: (message) => { if (message.type === 'geometry') geometry.push(message) }
  })
  const send = (...frames) => controller.enqueue(Buffer.concat(frames))
  const video = (id, flags = 0) => frame(KIND.VIDEO, videoPayload(flags, id, Buffer.of(id)))
  engine.handle({ type: 'open', streamUrl: '/video' })
  try {
    // 面板显示尺寸 400×800、DPR 2：backing 不应超过 800×1600。
    engine.handle({ type: 'viewport', width: 400, height: 800, dpr: 2 })
    send(frame(KIND.META, Buffer.from(JSON.stringify({
      type: 'meta', platform: 'ios', screen: { width: 1290, height: 2796 },
      videoCodec: 'hvc1.test', videoDescription: 'AA=='
    }))), video(1, VIDEO_FLAGS.KEY))
    for (let i = 0; i < 40 && blits.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(blits.length, 1)
    assert.ok(canvas.width <= 800 && canvas.height <= 1600, `backing=${canvas.width}x${canvas.height}`)
    assert.ok(canvas.width < 1290)
    // 绘制仍以设备像素为单位（由 setTransform 缩放）。
    assert.deepEqual(blits[0], [1290, 2796])
    // 几何按设备像素上报，客户端输入映射不受 backing 影响。
    assert.deepEqual(geometry.map((g) => [g.width, g.height]), [[1290, 2796]])
  } finally {
    engine.handle({ type: 'close' })
  }
})

// 重开会话清屏时必须先复位变换矩阵：遗留的 renderScale 缩放会把黑底
// 画成左上角一小块，看起来像画面上叠了个黑色矩形。
test('reopening resets the transform before clearing the canvas', async () => {
  const calls = []
  const canvas = { width: 640, height: 360, getContext: () => ({
    fillRect: (x, y, w, h) => calls.push(['fillRect', x, y, w, h]),
    setTransform: (...args) => calls.push(['setTransform', ...args]),
    save() {}, restore() {}, translate() {}, rotate() {}, drawImage() {}
  }) }
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame() { return 1 }, cancelAnimationFrame() {},
    fetch: async () => new Response(new ReadableStream({ start() {} })),
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }) }
      getContext() { return { drawImage() {}, setTransform() {} } }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor() {}
      configure() { this.state = 'configured' }
      decode() {}
      close() { this.state = 'closed' }
    }
  })
  const engine = createEngine({ canvas, post() {} })
  calls.length = 0
  engine.handle({ type: 'open', streamUrl: '/video' })
  await new Promise((resolve) => setImmediate(resolve))
  const open = calls.findIndex((call) => call[0] === 'setTransform' && call[1] === 1 && call[5] === 0)
  assert.ok(open >= 0, JSON.stringify(calls))
  const fill = calls[open + 1]
  assert.equal(fill[0], 'fillRect')
  assert.equal(fill[3], 640)
  assert.equal(fill[4], 360)
  engine.handle({ type: 'close' })
})
