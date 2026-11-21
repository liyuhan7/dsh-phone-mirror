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
      if (target.endsWith('/codec')) {
        return new Response(JSON.stringify({ display: { width: 1080, height: 1920, rotation: 0 } }))
      }
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

test('rotation packets update geometry instead of reaching the decoder', { timeout: 4000 }, async () => {
  const decoded = []
  const geometry = []
  const streams = { host: null, direct: null }
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame() { return 1 }, cancelAnimationFrame() {},
    fetch: async (url) => {
      const target = String(url)
      if (target.endsWith('/codec')) {
        return new Response(JSON.stringify({ display: { width: 1290, height: 2796, rotation: 0 } }))
      }
      const key = target.endsWith('/stream.bin') ? 'direct' : 'host'
      return new Response(new ReadableStream({ start(c) { streams[key] = c } }))
    },
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }) }
      getContext() { return { drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}, fillRect() {} } }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor({ output }) { this.output = output }
      configure() { this.state = 'configured' }
      decode(chunk) {
        decoded.push(chunk.data[0])
        this.output({ displayWidth: 1290, displayHeight: 2796, closed: 0, close() {} })
      }
      close() { this.state = 'closed' }
    }
  })
  const engine = createEngine({
    canvas: {
      width: 100, height: 200,
      getContext: (() => {
        const ctx = { drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}, fillRect() {} }
        return () => ctx
      })()
    },
    post: (message) => { if (message.type === 'geometry') geometry.push(message) }
  })
  const packet = (type, body) => {
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(body.length + 1)
    return Buffer.concat([prefix, Buffer.of(type), body])
  }
  engine.handle({ type: 'open', streamUrl: '/video', directVideoUrl: 'http://127.0.0.1:49152/stream.bin' })
  try {
    for (let i = 0; i < 20 && (!streams.host || !streams.direct); i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    streams.host.enqueue(frame(KIND.META, Buffer.from(JSON.stringify({
      type: 'meta', platform: 'ios', screen: { width: 1290, height: 2796 },
      videoCodec: 'hvc1.test', videoDescription: 'AA=='
    }))))
    streams.direct.enqueue(Buffer.concat([
      packet(2, Buffer.of(1)),
      packet(4, Buffer.from(JSON.stringify({ rotation: 90 }))),
      packet(1, Buffer.of(2))
    ]))
    for (let i = 0; i < 80 && geometry.length < 1; i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    // 朝向包不进解码器，只更新几何。
    assert.deepEqual(decoded, [1, 2])
    assert.ok(geometry.some((g) => g.rotation === 90 && g.width === 2796 && g.height === 1290), JSON.stringify(geometry))
    // 宿主 meta 里的旧朝向不得覆盖流内朝向（重连后 meta 会带初始值 0）。
    const before = geometry.length
    streams.host.enqueue(frame(KIND.META, Buffer.from(JSON.stringify({
      type: 'meta', platform: 'ios', rotation: 0, screen: { width: 1290, height: 2796 }
    }))))
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(geometry.length, before, JSON.stringify(geometry))
  } finally {
    engine.handle({ type: 'close' })
  }
})

// 直连视频瞬断时提示一次故障，恢复后（首个数据块到达）主动清掉提示，
// 不等下一条控制指令成功才清。
test('direct video fault note clears on recovery', { timeout: 6000 }, async () => {
  const notes = []
  let hostStream = null
  let directAttempts = 0
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame() { return 1 }, cancelAnimationFrame() {},
    fetch: async (url) => {
      const target = String(url)
      if (target.endsWith('/codec')) return new Response('{}')
      if (!target.endsWith('/stream.bin')) {
        return new Response(new ReadableStream({ start(c) { hostStream = c } }))
      }
      directAttempts += 1
      if (directAttempts === 1) throw new TypeError('network error')
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32BE(2)
      const chunk = Buffer.concat([prefix, Buffer.of(2, 1)])
      return new Response(new ReadableStream({ start(c) { c.enqueue(chunk) } }))
    },
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }) }
      getContext() { return { drawImage() {}, setTransform() {}, fillRect() {} } }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor({ output }) { this.output = output }
      configure() { this.state = 'configured' }
      decode() {}
      close() { this.state = 'closed' }
    }
  })
  const engine = createEngine({
    canvas: { width: 100, height: 200, getContext: () => ({
      drawImage() {}, setTransform() {}, fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}
    }) },
    post: (message) => { if (message.type === 'note') notes.push(message.message) }
  })
  engine.handle({ type: 'open', streamUrl: '/video', directVideoUrl: 'http://127.0.0.1:49152/stream.bin' })
  try {
    for (let i = 0; i < 200 && !(notes.length >= 2 && notes[1] === ''); i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(directAttempts, 2)
    assert.ok(notes[0]?.startsWith('视频直连失败'), JSON.stringify(notes))
    assert.equal(notes[1], '', JSON.stringify(notes))
  } finally {
    engine.handle({ type: 'close' })
  }
})

// 引擎重开（切标签页、断开重连）后 rotation 被清零，宿主 meta 只有启动
// 快照、流内朝向包只在变化时广播——/codec 的当前朝向是唯一可靠种子。
test('engine reopen seeds the current rotation from /codec', { timeout: 4000 }, async () => {
  const geometry = []
  const streams = { host: null, direct: null }
  const createEngine = runInNewContext(`${source}\ncreateMirrorEngine`, {
    self: { atob }, AbortController, TextDecoder, setTimeout, clearTimeout,
    setInterval() { return 1 }, clearInterval() {},
    requestAnimationFrame() { return 1 }, cancelAnimationFrame() {},
    fetch: async (url) => {
      const target = String(url)
      if (target.endsWith('/codec')) {
        // 手机此刻已是横屏：/codec 报告当前朝向 90。
        return new Response(JSON.stringify({
          codec: 'hvc1.test', display: { width: 1290, height: 2796, rotation: 90 }
        }))
      }
      const key = target.endsWith('/stream.bin') ? 'direct' : 'host'
      return new Response(new ReadableStream({ start(c) { streams[key] = c } }))
    },
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }) }
      getContext() { return { drawImage() {}, setTransform() {} } }
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor({ output }) { this.output = output }
      configure() { this.state = 'configured' }
      decode() { this.output({ displayWidth: 1290, displayHeight: 2796, closed: 0, close() {} }) }
      close() { this.state = 'closed' }
    }
  })
  const engine = createEngine({
    canvas: { width: 100, height: 200, getContext: () => ({
      drawImage() {}, setTransform() {}, fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}
    }) },
    post: (message) => { if (message.type === 'geometry') geometry.push(message) }
  })
  const packet = (type, body) => {
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(body.length + 1)
    return Buffer.concat([prefix, Buffer.of(type), body])
  }
  engine.handle({ type: 'open', streamUrl: '/video', directVideoUrl: 'http://127.0.0.1:49152/stream.bin' })
  try {
    for (let i = 0; i < 20 && (!streams.host || !streams.direct); i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    // 宿主 meta 只带启动快照（rotation 0）。
    streams.host.enqueue(frame(KIND.META, Buffer.from(JSON.stringify({
      type: 'meta', platform: 'ios', rotation: 0, screen: { width: 1290, height: 2796 },
      videoCodec: 'hvc1.test', videoDescription: 'AA=='
    }))))
    // 直连流只给关键帧，没有任何 type=4 朝向包。
    streams.direct.enqueue(packet(2, Buffer.of(1)))
    for (let i = 0; i < 80 && geometry.length < 1; i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(
      geometry.some((g) => g.rotation === 90 && g.width === 2796 && g.height === 1290),
      JSON.stringify(geometry)
    )
  } finally {
    engine.handle({ type: 'close' })
  }
})
