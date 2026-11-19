import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IosSession } from '../lib/providers/ios/session.js'

test('iOS resync starts at a live keyframe and never replays cached video', { timeout: 2000 }, async (t) => {
  const session = new IosSession({ serial: 'test' })
  session.state = 'running'
  const sent = []
  session.on('video', (packet) => sent.push([packet.data[0], packet.key, packet.reset]))
  const packet = (type, value) => Uint8Array.of(0, 0, 0, 2, type, value)
  const requests = []
  session.$postJson = async (path) => requests.push(path)
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(packet(0, 1)) // sidecar bootstrap cache
      controller.enqueue(packet(1, 2))
      controller.enqueue(packet(2, 3)) // first live key
      controller.enqueue(packet(1, 4))
      session.on('video', ({ data }) => {
        if (data[0] !== 4) return
        session.requestKeyframe()
        controller.enqueue(packet(1, 5))
        controller.enqueue(packet(0, 6)) // plain live key becomes reset key
        controller.enqueue(packet(1, 7))
        controller.close()
      })
    }
  })))
  session.on('video', ({ data }) => { if (data[0] === 7) session.state = 'stopped' })
  await session.$pumpVideo()
  assert.deepEqual(requests, ['/pli'])
  assert.deepEqual(sent, [[3, true, true], [4, false, false], [6, true, true], [7, false, false]])
})
