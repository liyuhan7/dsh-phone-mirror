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
import json
import logging
import os
import plistlib
import shutil
import sys
import tempfile
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
from pymobiledevice3.exceptions import (  # noqa: E402
    DeviceNotFoundError,
    InvalidServiceError,
    NotPairedError,
    PasswordRequiredError,
    RemotePairingCompletedError,
    UserspaceTunnelUnavailableError,
)
from pymobiledevice3.lockdown import create_using_usbmux  # noqa: E402
from pymobiledevice3.remote import tunnel_service, userspace_tunnel  # noqa: E402
from pymobiledevice3.remote.core_device.display_service import DisplayService  # noqa: E402
from pymobiledevice3.remote.core_device.hid_service import (  # noqa: E402
    HID_BUTTON_STATE_DOWN,
    HID_BUTTON_STATE_UP,
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
            if not lockdown.paired:
                await lockdown.pair()
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

    # Wireless path: try RemotePairing tunnel over the network.
    try:
        tunnel = userspace_tunnel.UserspaceRsdTunnel(
            serial=udid, remotepairing_fallback=True, remotepairing=True
        )
        rsd = await tunnel.aopen()
        return rsd, tunnel, "iPhone (Wi-Fi)"
    except (UserspaceTunnelUnavailableError, DeviceNotFoundError) as remote_error:
        # Apple Devices can also publish a trusted Wi-Fi device through usbmux.
        # Explicitly require Network here: plugged-in USB must never pass a Wi-Fi test.
        async def network_provider():
            lockdown = await create_using_usbmux(serial=udid, autopair=False, connection_type="Network")
            try:
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
        if not lockdown.paired:
            await lockdown.pair()
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


class MirrorScreenStreamServer(ScreenStreamServer):
    async def _handle_key(self, body: bytes) -> tuple[int, bytes]:
        try:
            data = json.loads(body)
            detach = data.get("detach") is True
            recents = data.get("recents") is True
        except (ValueError, AttributeError):
            detach = False
            recents = False
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
        if not detach:
            return await super()._handle_key(body)
        async with self._hid_lock:
            if self._kb_service_id is not None and self._uhs is not None:
                # 关闭 UHS 即注销虚拟键盘，下次触控会重新打开且不带键盘。
                await self._uhs.close()
                self._uhs = None
                self._kb_service_id = None
                self._touch_service_id = None
        return 200, b"ok"


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
        await serve_task
        hid_warm.cancel()
        return 0
    except Exception as exc:
        _emit({"type": "error", "message": str(exc)})
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
