#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""
dsh-phone-mirror iOS sidecar bridge.

Wraps pymobiledevice3's CoreDevice ScreenStreamServer in a standalone process:
  - Prefers local / .plist.tmp pairing records when Windows AMDS leaves stale .plist files
  - Supplies a cross-platform PyAV AAC-ELD -> s16le 48kHz stereo PCM decoder
  - Auto-mounts the Developer Disk Image (Cryptex1 / Personalized DDI) when needed
  - Supports both USB (usbmux) and Wi-Fi (RemotePairing) userspace tunnels without admin rights
  - Supports promptless USB-to-Wi-Fi RemotePairing bootstrap (`pair-wireless` subcommand)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import ipaddress
import json
import logging
import os
import plistlib
import shutil
import socket
import struct
import sys
import tempfile
import time
from functools import partial
from pathlib import Path
from typing import Any, Optional


def _ensure_writable_home() -> Path:
    """Ensure pymobiledevice3's home folder (~/.pymobiledevice3) is writable;
    fall back to a workspace-local home if the OS user profile is restricted."""
    here = Path(__file__).resolve().parent
    candidates = [
        Path("D:/dsh-common/dsh-phone-mirror/.tmp/home"),
        here.parent / ".tmp" / "home",
        here.parent.parent / ".tmp" / "home",
        Path.home(),
    ]
    chosen: Optional[Path] = None
    for base in candidates:
        target = base / ".pymobiledevice3"
        try:
            if not target.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            probe = target / ".write_probe"
            probe.write_bytes(b"ok")
            chosen = base
            break
        except Exception:
            continue

    if chosen is None:
        for base in candidates:
            if (base / ".pymobiledevice3").is_dir():
                chosen = base
                break
    if chosen is None:
        chosen = candidates[0]

    # Sync any existing .plist records between the candidates so neither path misses records.
    dst_dir = chosen / ".pymobiledevice3"
    for src_base in candidates:
        src_dir = src_base / ".pymobiledevice3"
        if src_dir == dst_dir or not src_dir.is_dir():
            continue
        with contextlib.suppress(Exception):
            for plist_file in src_dir.glob("*.plist"):
                dst_file = dst_dir / plist_file.name
                if not dst_file.exists():
                    shutil.copy2(plist_file, dst_file)

    os.environ["USERPROFILE"] = str(chosen)
    os.environ["HOME"] = str(chosen)
    os.environ["TEMP"] = str(chosen)
    os.environ["TMP"] = str(chosen)
    os.environ["TMPDIR"] = str(chosen)
    tempfile.tempdir = str(chosen)
    return dst_dir


_PMD_HOME = _ensure_writable_home()

import av  # noqa: E402
import pymobiledevice3.common as pmd_common  # noqa: E402
import pymobiledevice3.lockdown as pmd_lockdown  # noqa: E402
import pymobiledevice3.pair_records as pmd_pair_records  # noqa: E402
import pymobiledevice3.remote.core_device.screen_stream as pmd_screen_stream  # noqa: E402
from pymobiledevice3.bonjour import browse_remotepairing  # noqa: E402
from pymobiledevice3.exceptions import (  # noqa: E402
    ConnectionTerminatedError,
    DeviceNotFoundError,
    InvalidServiceError,
    MuxException,
    NotPairedError,
    PasswordRequiredError,
    RemotePairingCompletedError,
    UserspaceTunnelUnavailableError,
)
from pymobiledevice3.lockdown import create_using_usbmux  # noqa: E402
from pymobiledevice3.remote import tunnel_service, userspace_tunnel  # noqa: E402
from pymobiledevice3.remote.core_device.display_service import DisplayService  # noqa: E402
from pymobiledevice3.remote.core_device.hid_service import (  # noqa: E402
    DIGITIZER_SURFACE_TOUCHSCREEN_GESTURE,
    HID_BUTTON_STATE_DOWN,
    HID_BUTTON_STATE_UP,
    build_digitizer_report,
)
from pymobiledevice3.remote.core_device.pasteboard_service import (  # noqa: E402
    UTI_PLAIN_TEXT,
    UTI_TEXT,
    UTI_UTF8_PLAIN_TEXT,
    PasteboardService,
)
from pymobiledevice3.remote.core_device.screen_stream import (  # noqa: E402
    ScreenStreamServer,
    hevc_decoder_configuration_record,
)
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService  # noqa: E402
from pymobiledevice3.remote.tunnel_service import RemotePairingLockdownService  # noqa: E402
from pymobiledevice3.services.amfi import AmfiService  # noqa: E402
from pymobiledevice3.services.mobile_image_mounter import auto_mount  # noqa: E402

pmd_common._HOMEFOLDER = _PMD_HOME


async def _watch_stdin(stop: asyncio.Event) -> None:
    """Node 父进程写入 quit（或关闭 stdin）时请求退出，让 serve() 走正常清理。"""
    loop = asyncio.get_running_loop()
    while True:
        try:
            line = await loop.run_in_executor(None, sys.stdin.readline)
        except Exception:
            stop.set()
            return
        if not line or line.strip().lower() in {"quit", "exit"}:
            stop.set()
            return


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


_orig_get_preferred_pair_record = pmd_pair_records.get_preferred_pair_record


async def _patched_get_preferred_pair_record(
    identifier: str, pairing_records_cache_folder: Path, usbmux_address: Optional[str] = None
) -> Optional[dict[str, Any]]:
    local = pmd_pair_records.get_local_pairing_record(identifier, pairing_records_cache_folder)
    if local is not None:
        return local
    with contextlib.suppress(Exception):
        lockdown_dir = pmd_pair_records.OSUTILS.pair_record_path
        tmp_path = lockdown_dir / f"{identifier}.plist.tmp"
        std_path = lockdown_dir / f"{identifier}.plist"
        if tmp_path.exists():
            if not std_path.exists() or tmp_path.stat().st_mtime >= std_path.stat().st_mtime:
                record = plistlib.loads(tmp_path.read_bytes())
                with contextlib.suppress(Exception):
                    (pairing_records_cache_folder / f"{identifier}.plist").write_bytes(tmp_path.read_bytes())
                return record
    return await _orig_get_preferred_pair_record(
        identifier, pairing_records_cache_folder, usbmux_address=usbmux_address
    )


pmd_pair_records.get_preferred_pair_record = _patched_get_preferred_pair_record
pmd_lockdown.get_preferred_pair_record = _patched_get_preferred_pair_record


# CoreDevice 音频是 AAC-ELD 48 kHz 立体声、每包 480 样本；上游 ASC 记录的是
# 512 样本（frameLengthFlag=0），直接解码会拒帧或错位，这里改为 480 样本的 ASC。
ELD_ASC_48K_STEREO_480 = bytes.fromhex("f8e65000")


class PyAVAACELDDecoder:
    """Decode single AAC-ELD access units (48 kHz stereo, 480 frames/packet) into
    interleaved signed 16-bit little-endian stereo PCM bytes using PyAV/FFmpeg."""

    def __init__(self, magic_cookie: bytes = ELD_ASC_48K_STEREO_480) -> None:
        self._ctx = self._open_decoder()
        self._resampler = av.AudioResampler(format="s16", layout="stereo", rate=48000)

    @staticmethod
    def _open_decoder() -> av.CodecContext:
        ctx = av.CodecContext.create("aac", "r")
        ctx.extradata = ELD_ASC_48K_STEREO_480
        ctx.sample_rate = 48000
        ctx.open()
        return ctx

    def decode(self, au: bytes) -> bytes:
        # 静音时设备只发 4 字节空包，按帧解码会触发上游的重建风暴。
        if len(au) < 16:
            return b""
        out = bytearray()
        try:
            for frame in self._ctx.decode(av.Packet(au)):
                for resampled in self._resampler.resample(frame):
                    # s16 plane 按对齐补零，只取有效样本以保持 10 ms 时间轴。
                    raw = bytes(resampled.planes[0])
                    out.extend(raw[: resampled.samples * 4])
        except Exception:
            # 坏包就地重建解码器并丢弃该帧，不向上抛。
            self._reset()
            return b""
        return bytes(out)

    def _reset(self) -> None:
        # CodecContext 没有 close()，换新实例交给 GC。
        self._ctx = self._open_decoder()
        self._resampler = av.AudioResampler(format="s16", layout="stereo", rate=48000)


pmd_screen_stream.AACELDDecoder = PyAVAACELDDecoder  # type: ignore[misc]
pmd_screen_stream.AAC_ELD_ASC_48K_STEREO_480 = ELD_ASC_48K_STEREO_480  # type: ignore[attr-defined]
ScreenStreamServer._missing_audio_deps = staticmethod(lambda: [])  # type: ignore[method-assign]


def _aac_eld_supported() -> bool:
    """本机 FFmpeg 是否能解 CoreDevice 的 AAC-ELD（AOT 39，480 样本/帧）。"""
    try:
        PyAVAACELDDecoder._open_decoder()
        return True
    except Exception:
        return False


async def _ensure_usb_pairing(lockdown) -> None:
    if lockdown.paired:
        return
    previous = lockdown.pair_record
    try:
        await lockdown.pair()
    except MuxException as exc:
        # PMD 先写本地记录，再交给 usbmuxd；AMDS 拒绝自己的副本时仍须向设备验证。
        if (sys.platform != "win32" or "SavePairRecord request:" not in str(exc)
                or "'Number': 183}" not in str(exc)
                or not lockdown.pair_record or lockdown.pair_record is previous):
            raise
    if not await lockdown.validate_pairing():
        raise NotPairedError("iPhone 未接受此电脑的 USB 信任记录")


def _remote_addresses(answer):
    if sys.platform != "win32":
        return [address.full_ip for address in answer.addresses]

    ipv4 = [address.ip for address in answer.addresses if ":" not in address.ip]
    ipv6 = []
    lan_scopes = _lan_ipv6_scopes(ipv4)
    for address in answer.addresses:
        if ":" not in address.ip:
            continue
        if not ipaddress.ip_address(address.ip).is_link_local:
            ipv6.append(address.ip)
            continue
        # PMD may guess a VPN adapter for fe80::/64. Prefer the LAN inferred from the phone's A record.
        scopes = lan_scopes
        if not scopes and address.iface:
            with contextlib.suppress(OSError):
                scopes = [socket.if_nametoindex(address.iface)]
        ipv6.extend(f"{address.ip}%{scope}" for scope in scopes)
    return ipv4 + ipv6


def _lan_ipv6_scopes(ipv4):
    import ifaddr

    matches = []
    for adapter in ifaddr.get_adapters():
        scopes = {addr.ip[2] for addr in adapter.ips if addr.is_IPv6 and addr.ip[2]}
        for addr in adapter.ips:
            if addr.is_IPv4 and any(ipaddress.ip_address(ip) in ipaddress.ip_network(
                f"{addr.ip}/{addr.network_prefix}", strict=False
            ) for ip in ipv4):
                matches.extend((addr.network_prefix, scope) for scope in sorted(scopes))
    return list(dict.fromkeys(scope for _, scope in sorted(matches, reverse=True)))


async def _open_remote_tunnel(udid: str):
    record = pmd_pair_records.get_local_pairing_record(
        pmd_pair_records.get_remote_pairing_record_filename(udid), _PMD_HOME
    )
    irk = (record or {}).get(tunnel_service.PEER_ALT_IRK_KEY)
    if not isinstance(irk, bytes) or len(irk) != 16:
        raise UserspaceTunnelUnavailableError("无可用的无线配对记录，请插线后点「转无线」")

    endpoints = {}
    for answer in await browse_remotepairing(timeout=4):
        if tunnel_service._match_remote_pair_record(answer, {udid: irk}) == udid:
            endpoints.update(dict.fromkeys((host, answer.port) for host in _remote_addresses(answer)))
    if not endpoints:
        raise DeviceNotFoundError(udid, "没有发现与配对记录匹配的 iPhone 无线地址")

    errors = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 10
    # PMD 11.58 的 listener TCP 是同步连接，外层 asyncio.timeout 无法中断它。
    original_connect = tunnel_service.create_connection
    tunnel_service.create_connection = partial(original_connect, timeout=2.5)
    try:
        for host, port in endpoints:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            stage = "连接 RemotePairing 服务或验证配对"

            async def remote_provider():
                nonlocal stage
                service = await tunnel_service.create_core_device_tunnel_service_using_remotepairing(
                    udid, host, port, autopair=False, connect_timeout=2
                )
                stage = "建立 TCP/RSD 隧道"
                return userspace_tunnel.TunnelProvider(service)

            tunnel = userspace_tunnel.UserspaceRsdTunnel(provider_factory=remote_provider)
            try:
                async with asyncio.timeout(min(5, remaining)):
                    rsd = await tunnel.aopen()
                return rsd, tunnel
            except (OSError, ConnectionTerminatedError, asyncio.IncompleteReadError) as exc:
                errors.append(f"{stage}失败（{host}）：{str(exc) or type(exc).__name__}")
    finally:
        tunnel_service.create_connection = original_connect
    raise OSError("；".join(errors) or "RemotePairing 连接超时")


async def _open_rsd(udid: str, wireless: bool) -> tuple[RemoteServiceDiscoveryService, Any, str]:
    """Open a userspace RSD tunnel over USB or RemotePairing Wi-Fi."""
    if not wireless:
        try:
            lockdown = await create_using_usbmux(serial=udid, autopair=False)
        except PasswordRequiredError as exc:
            raise RuntimeError("请先解锁 iPhone，再点击连接") from exc
        except NotPairedError as exc:
            raise RuntimeError("尚未信任此电脑：请解锁 iPhone，在弹窗中点击「信任」并输入锁屏密码") from exc

        try:
            await _ensure_usb_pairing(lockdown)
            dev_mode = await lockdown.get_developer_mode_status()
            if not dev_mode:
                with contextlib.suppress(Exception):
                    await AmfiService(lockdown).reveal_developer_mode_option_in_ui()
                raise RuntimeError(
                    "iPhone 尚未开启开发者模式：请打开手机「设置 → 隐私与安全性 → 开发者模式」并重启确认"
                )
            device_name = lockdown.short_info.get("DeviceName") or "iPhone"
        finally:
            await lockdown.close()

        tunnel = userspace_tunnel.UserspaceRsdTunnel(
            serial=udid, remotepairing_fallback=True, remotepairing=False
        )
        rsd = await tunnel.aopen()
        return rsd, tunnel, device_name

    try:
        rsd, tunnel = await _open_remote_tunnel(udid)
        return rsd, tunnel, "iPhone (Wi-Fi)"
    except (UserspaceTunnelUnavailableError, DeviceNotFoundError, OSError) as remote_error:
        # Apple Devices can also publish a trusted Wi-Fi device through usbmux.
        # Explicitly require Network here: plugged-in USB must never pass a Wi-Fi test.
        async def network_provider():
            lockdown = await create_using_usbmux(serial=udid, autopair=False, connection_type="Network")
            try:
                if not lockdown.paired:
                    raise NotPairedError("Apple Devices 未建立受信任的 Wi-Fi 会话")
                proxy = await tunnel_service.CoreDeviceTunnelProxy.create(lockdown)
                return userspace_tunnel.TunnelProvider(proxy, lockdown)
            except BaseException:
                await lockdown.close()
                raise

        try:
            tunnel = userspace_tunnel.UserspaceRsdTunnel(provider_factory=network_provider)
            rsd = await tunnel.aopen()
            return rsd, tunnel, "iPhone (Wi-Fi)"
        except Exception as network_error:
            raise RuntimeError(
                f"无线连接失败。请确认 iPhone 已解锁、与电脑处于同一局域网。"
                f"RemotePairing：{remote_error}；Apple Devices Wi-Fi：{network_error}"
            ) from network_error


async def _ensure_ddi_mounted(rsd: RemoteServiceDiscoveryService) -> None:
    services = rsd.peer_info.get("Services", {})
    if DisplayService.SERVICE_NAME in services:
        return
    _emit({"type": "stage", "message": "正在挂载 iOS 开发者镜像（首次或重启后需数秒）…"})
    try:
        await auto_mount(rsd)
    except Exception as exc:
        # On slow networks cryptexd can finish mounting right around the 60s mark;
        # callers re-open the RSD tunnel afterwards to refresh the service table.
        logging.getLogger(__name__).warning("auto_mount raised %s; will re-check services", exc)


async def cmd_pair_wireless(udid: str) -> int:
    try:
        lockdown = await create_using_usbmux(serial=udid, autopair=False, connection_type="USB")
    except Exception as exc:
        _emit({"type": "error", "message": f"需要通过 USB 连接并解锁的 iPhone 才能配置无线连接：{exc}"})
        return 1

    try:
        await _ensure_usb_pairing(lockdown)
        with contextlib.suppress(Exception):
            await lockdown.set_enable_wifi_connections(True)
        service = await RemotePairingLockdownService.create(lockdown)
        try:
            try:
                await service.connect(autopair=True)
            except RemotePairingCompletedError:
                await service.close()
                service = await RemotePairingLockdownService.create(lockdown)
                await service.connect(autopair=False)
        finally:
            await service.close()

        # Copy remote_<udid>.plist to ~/.pymobiledevice3 as well so all tools find it.
        real_home_pmd = Path(os.path.expanduser("~")) / ".pymobiledevice3"
        with contextlib.suppress(Exception):
            for rec in _PMD_HOME.glob("remote_*.plist"):
                real_home_pmd.mkdir(parents=True, exist_ok=True)
                dst = real_home_pmd / rec.name
                if dst != rec:
                    shutil.copy2(rec, dst)

        _emit({"type": "paired", "udid": udid, "serial": f"wifi:{udid}"})
        return 0
    except PasswordRequiredError:
        _emit({"type": "error", "message": "请解锁 iPhone，保持 USB 连接后再点「转无线」"})
        return 1
    except InvalidServiceError:
        try:
            await lockdown.set_enable_wifi_connections(True)
        except Exception as exc:
            _emit({"type": "error", "message": f"设备不支持 RemotePairing，且无法开启 Apple Devices Wi-Fi：{exc}"})
            return 1
        _emit({"type": "paired", "udid": udid, "serial": f"wifi:{udid}"})
        return 0
    except Exception as exc:
        _emit({"type": "error", "message": f"无线配对失败：{exc}"})
        return 1
    finally:
        await lockdown.close()


def _clean_message(text: str) -> str:
    """错误信息里可能带协议原始字节，去掉不可打印字符并截断，避免界面上出现乱码。"""
    cleaned = "".join(ch for ch in str(text) if ch.isprintable() or ch in " \n\t")
    return " ".join(cleaned.split())[:300] or "连接失败"


def _scroll_chunks(dx: int, dy: int) -> list[tuple[int, int]]:
    """把一次合并后的增量拆成 int8 范围内的若干段，超出的量不丢失。"""
    chunks = []
    while dx or dy:
        chunk_x = max(-127, min(127, dx))
        chunk_y = max(-127, min(127, dy))
        chunks.append((chunk_x, chunk_y))
        dx, dy = dx - chunk_x, dy - chunk_y
    return chunks


def _scroll_report(dx: int, dy: int, phase: int, momentum: int = 0) -> bytes:
    """21 字节 Scroll 报告：ID 7，阶段、增量、16.16 加速度与 48 位时间戳。"""
    timestamp = time.monotonic_ns() & ((1 << 48) - 1)
    return (
        bytes([7, phase, momentum]) + struct.pack("<bb", dx, dy)
        + struct.pack("<ii", dx * 65536, dy * 65536)
        + timestamp.to_bytes(6, "little") + b"\x00\x00"
    )


def _paste_item(text: str) -> dict[str, Any]:
    """手机剪贴板条目：UTF-8 文本 + 「临时/敏感」标记。

    org.nspasteboard.TransientType / ConcealedType 是通用标记：剪贴板历史类工具会跳过，
    系统也知道这条内容不是用户主动复制的，能减少「粘贴自」这类归属提示。
    """
    payload = text.encode("utf-8")
    types = [UTI_UTF8_PLAIN_TEXT, UTI_PLAIN_TEXT, UTI_TEXT]
    data = {uti: {"data": payload} for uti in types}
    for marker in ("org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType"):
        types.append(marker)
        data[marker] = {"data": b""}
    return {"types": types, "data": data}


class MirrorScreenStreamServer(ScreenStreamServer):
    _scroll_active = False
    _scroll_end_handle = None
    # 粘贴板连接常驻复用：每次粘贴省掉一次 RemoteXPC 连接（几十到上百毫秒）。
    _pasteboard = None

    async def _ensure_pasteboard(self):
        if self._pasteboard is None:
            service = PasteboardService(self._rsd)
            await service.connect()
            self._pasteboard = service
        return self._pasteboard

    async def _drop_pasteboard(self) -> None:
        service, self._pasteboard = self._pasteboard, None
        if service is not None:
            with contextlib.suppress(Exception):
                await service.close()

    async def _paste_text(self, text: str) -> None:
        """电脑输入法提交的文本：写手机剪贴板后按 ⌘V 四段和弦粘贴进手机。

        HID 键盘打不出 Unicode，中文只能经剪贴板进手机（与 Device Hub / ipb 一致）。
        延迟靠三件事压住：粘贴板连接常驻（省掉连接开销）、写完只等 8ms、
        和弦间隔 15ms，单次粘贴约 60~80ms，不会卡在打字路径上。
        """
        try:
            await self._ensure_keyboard()
        except Exception:
            logging.warning("paste: keyboard service failed", exc_info=True)
            return
        try:
            service = await self._ensure_pasteboard()
            await asyncio.wait_for(service.set([_paste_item(text[:65536])]), timeout=1.5)
        except Exception:
            logging.warning("paste: clipboard write failed", exc_info=True)
            await self._drop_pasteboard()
            return
        # 让剪贴板变更在系统内生效，再发和弦。
        await asyncio.sleep(0.008)
        for step in ([0xE3], [0xE3, 0x19], [0x19], []):
            await self._uhs.send_keyboard(self._kb_service_id, step)
            await asyncio.sleep(0.015)

    async def _ensure_keyboard(self) -> None:
        """用设备自带的键盘服务，而不是主机注册的虚拟键盘。

        虚拟键盘会顶掉手机输入法；发到自带键盘服务上的按键仍由手机输入法处理。
        """
        await self._ensure_hid()
        if self._kb_service_id is not None:
            return
        async with self._hid_lock:
            if self._kb_service_id is not None:
                return
            response = await self._uhs.list_connected_services()
            for service in response.get("connectedServices", []):
                if service.get("DeviceTypeHint") == "Keyboard" and "_ServiceID" in service:
                    self._kb_service_id = int(service["_ServiceID"])
                    return
            self._kb_service_id = await self._uhs.create_keyboard_service()

    async def _send_scroll(self, scroll: dict[str, Any]) -> None:
        # 客户端 dy 为「向上为正」（scrcpy 习惯），实测设备方向相反，
        # 所以对 x/y 取反；一格滚轮（客户端 1 单位）放大约 36 个设备增量。
        scale = 36
        dx = -max(-127, min(127, round(float(scroll.get("dx", 0)) * scale)))
        dy = -max(-127, min(127, round(float(scroll.get("dy", 0)) * scale)))
        if dx == 0 and dy == 0:
            return
        pointer = build_digitizer_report(
            round(float(scroll.get("x", 0.5)) * 65536),
            round(float(scroll.get("y", 0.5)) * 65536),
        )
        await self._ensure_hid()
        service = DIGITIZER_SURFACE_TOUCHSCREEN_GESTURE
        # 与抓包一致的持续手势：首个增量走 mayBegin+began，后续增量走 changed，
        # 停止 120ms 后发 ended；不发 momentum，滚轮停下即停住。
        phase = 0x02 if self._scroll_active else 0x01
        reports = [pointer] if self._scroll_active else [
            pointer,
            _scroll_report(0, 0, 0x80),
        ]
        for index, (chunk_x, chunk_y) in enumerate(_scroll_chunks(dx, dy)):
            reports.append(_scroll_report(chunk_x, chunk_y, 0x02 if index else phase))
        async with self._hid_lock:
            for report in reports:
                await self._uhs.send_report(service, report)
            self._scroll_active = True
        self._schedule_scroll_end()

    def _schedule_scroll_end(self) -> None:
        if self._scroll_end_handle is not None:
            self._scroll_end_handle.cancel()
        loop = asyncio.get_running_loop()
        self._scroll_end_handle = loop.call_later(0.12, self._scroll_end)

    def _scroll_end(self) -> None:
        self._scroll_end_handle = None

        async def close() -> None:
            async with self._hid_lock:
                if not self._scroll_active or self._uhs is None:
                    return
                try:
                    await self._uhs.send_report(
                        DIGITIZER_SURFACE_TOUCHSCREEN_GESTURE, _scroll_report(0, 0, 0x04)
                    )
                except Exception:
                    logging.debug("scroll end failed", exc_info=True)
                finally:
                    self._scroll_active = False

        asyncio.create_task(close())

    async def _stop_hid(self) -> None:
        self._scroll_active = False
        if self._scroll_end_handle is not None:
            self._scroll_end_handle.cancel()
            self._scroll_end_handle = None
        await super()._stop_hid()

    async def _handle_key(self, body: bytes) -> tuple[int, bytes]:
        try:
            data = json.loads(body)
            recents = data.get("recents") is True
            scroll = data.get("scroll")
            paste = data.get("paste")
        except (ValueError, AttributeError):
            recents = False
            scroll = None
            paste = None
        if isinstance(paste, str) and paste:
            await self._paste_text(paste)
            return 200, b"ok"
        if isinstance(scroll, dict):
            await self._send_scroll(scroll)
            return 200, b"ok"
        if recents:
            # App 切换器 = 连按两次 Home（Consumer 页 0x0C / 用法 0x40）。
            await self._ensure_hid()
            indigo = self._indigo
            for _ in range(2):
                await indigo.send_button(0x0C, 0x40, HID_BUTTON_STATE_DOWN)
                await asyncio.sleep(0.06)
                await indigo.send_button(0x0C, 0x40, HID_BUTTON_STATE_UP)
                await asyncio.sleep(0.12)
            return 200, b"ok"
        return await super()._handle_key(body)


async def cmd_serve(udid: str, port: int, wireless: bool) -> int:
    stack_ctx = None
    rsd: Optional[RemoteServiceDiscoveryService] = None
    try:
        rsd, stack_ctx, device_name = await _open_rsd(udid, wireless)
        if DisplayService.SERVICE_NAME not in rsd.peer_info.get("Services", {}):
            await _ensure_ddi_mounted(rsd)
            with contextlib.suppress(Exception):
                await rsd.close()
            if stack_ctx is not None:
                with contextlib.suppress(Exception):
                    await stack_ctx.aclose()
            rsd, stack_ctx, device_name = await _open_rsd(udid, wireless)

        version_str = str(rsd.product_version)
        major = int(version_str.split(".")[0]) if version_str and version_str[0].isdigit() else 0
        if major < 27:
            _emit({
                "type": "error",
                "message": f"当前设备系统为 iOS {version_str}，CoreDevice 实时画面流需要 iOS 27 及以上版本",
            })
            return 1

        server = MirrorScreenStreamServer(
            rsd,
            bind="127.0.0.1",
            http_port=port,
            audio_default_on=True,
            motion_idr=True,
        )

        serve_task = asyncio.create_task(server.serve())
        deadline = asyncio.get_running_loop().time() + 28.0
        while not server._stream_ready.is_set():
            if serve_task.done():
                exc = serve_task.exception()
                raise exc if exc else RuntimeError("ScreenStreamServer 提前退出")
            if asyncio.get_running_loop().time() > deadline:
                raise RuntimeError("等待 iPhone 画面流就绪超时，请确认手机没有打开相机或通话")
            await asyncio.sleep(0.05)

        width, height = server._display_size or (1170, 2532)
        description = None
        if server._codec_string and server._vps_nal and server._sps_nal and server._pps_nal:
            hvcc = hevc_decoder_configuration_record(server._vps_nal, server._sps_nal, server._pps_nal)
            description = base64.b64encode(hvcc).decode()
        _emit({
            "type": "ready",
            "port": port,
            "udid": udid,
            "deviceName": device_name,
            "productVersion": version_str,
            "codec": server._codec_string,
            "description": description,
            "screen": {"width": width, "height": height, "rotation": server._display_rotation},
            "connection": "wifi" if wireless else "usb",
            "audio": _aac_eld_supported(),
        })
        # HID 预热放到就绪之后，不阻塞首帧。
        async def warm_hid() -> None:
            with contextlib.suppress(Exception):
                await server._ensure_hid()

        hid_warm = asyncio.create_task(warm_hid())
        if os.environ.get("PHONE_MIRROR_STDIN_QUIT") != "1" or sys.stdin is None:
            await serve_task
            hid_warm.cancel()
            return 0

        stop = asyncio.Event()
        stdin_task = asyncio.create_task(_watch_stdin(stop))
        stop_wait = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait({serve_task, stop_wait}, return_when=asyncio.FIRST_COMPLETED)
            if serve_task in done:
                exc = serve_task.exception()
                if exc:
                    raise exc
        finally:
            hid_warm.cancel()
            stop_wait.cancel()
            stdin_task.cancel()
            serve_task.cancel()
            with contextlib.suppress(BaseException):
                await serve_task
        return 0
    except Exception as exc:
        _emit({"type": "error", "message": _clean_message(exc)})
        return 1
    finally:
        if rsd is not None:
            with contextlib.suppress(Exception):
                await rsd.close()
        if stack_ctx is not None:
            with contextlib.suppress(Exception):
                await stack_ctx.aclose()


def main() -> int:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    parser = argparse.ArgumentParser(description="dsh-phone-mirror iOS bridge")
    sub = parser.add_subparsers(dest="command", required=True)

    serve_p = sub.add_parser("serve")
    serve_p.add_argument("--udid", required=True)
    serve_p.add_argument("--port", type=int, required=True)
    serve_p.add_argument("--wireless", action="store_true")

    pair_p = sub.add_parser("pair-wireless")
    pair_p.add_argument("--udid", required=True)

    args = parser.parse_args()
    if args.command == "pair-wireless":
        return asyncio.run(cmd_pair_wireless(args.udid))
    return asyncio.run(cmd_serve(args.udid, args.port, args.wireless))


if __name__ == "__main__":
    raise SystemExit(main())
