// 宿主推给侧边栏引擎的统一帧格式：
//   [u32 长度][u8 类型][载荷]
//   1 = 视频  : [u8 标志(0x40 配置包 / 0x20 关键帧 / 0x10 重建解码器)][u64 大端 PTS][视频载荷]
//   2 = 音频  : [u8 标志(0x40 配置包 / 0x01 PCM 直通)][u64 大端 PTS][音频载荷]
//   3 = 元数据: UTF-8 JSON
//   4 = 图像  : PNG（兜底模式的截图）

export const KIND = {
  VIDEO: 1,
  AUDIO: 2,
  META: 3,
  IMAGE: 4
}

export const VIDEO_FLAGS = {
  CONFIG: 0x40,
  KEY: 0x20,
  RESET: 0x10
}

export const AUDIO_FLAGS = {
  CONFIG: 0x40,
  PCM: 0x01
}

export function frame(kind, payload) {
  const header = Buffer.allocUnsafe(5)
  header.writeUInt32BE(payload.length + 1, 0)
  header.writeUInt8(kind, 4)
  return Buffer.concat([header, payload], header.length + payload.length)
}

export function videoPayload(flags, pts, data) {
  const head = Buffer.allocUnsafe(9)
  head.writeUInt8(flags, 0)
  head.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(pts ?? 0))), 1)
  return Buffer.concat([head, data], head.length + data.length)
}

export const metaPayload = (value) => Buffer.from(JSON.stringify(value), 'utf8')
