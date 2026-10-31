// 引擎 Worker 启动代码。宿主把它与 lib/engine.js 拼接后下发，两者共享同一作用域。
/* global self, createMirrorEngine */
let engine = null

self.onmessage = (event) => {
  const message = event.data
  if (!engine) {
    // 第一帧必须是画布：引擎在创建时就绑定了这块 OffscreenCanvas。
    if (message?.type !== 'init') return
    engine = createMirrorEngine({
      canvas: message.canvas,
      post: (data) => self.postMessage(data)
    })
    return
  }
  engine.handle(message)
}

self.postMessage({ type: 'ready' })
