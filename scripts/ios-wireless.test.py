import base64
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import ios_bridge as bridge
from pymobiledevice3.bonjour import Address, ServiceInstance
from pymobiledevice3.remote.siphash import compute_auth_tag


class WirelessTests(unittest.IsolatedAsyncioTestCase):
    async def test_amds_collision_requires_validating_new_local_record(self):
        error = bridge.MuxException("usbmuxd rejected the SavePairRecord request: {'MessageType': 'Result', 'Number': 183}")
        lockdown = SimpleNamespace(paired=False, pair_record=None, validate_pairing=AsyncMock(return_value=True))

        async def pair():
            lockdown.pair_record = {"HostID": "new"}
            raise error

        lockdown.pair = pair
        with patch.object(sys, "platform", "win32"):
            await bridge._ensure_usb_pairing(lockdown)
            lockdown.validate_pairing.assert_awaited_once()
            lockdown.validate_pairing.return_value = False
            with self.assertRaises(bridge.NotPairedError):
                await bridge._ensure_usb_pairing(lockdown)
            lockdown.pair = AsyncMock(side_effect=error)
            with self.assertRaises(bridge.MuxException):
                await bridge._ensure_usb_pairing(lockdown)
            self.assertEqual(lockdown.validate_pairing.await_count, 2)

    async def test_retry_full_tunnel_on_matched_windows_ipv6_address(self):
        key = bytes(range(16))
        tag = base64.b64encode(compute_auth_tag(key, "phone")).decode()
        answers = [
            ServiceInstance("other", None, 49152, [Address("192.0.2.9", "LAN")], {
                "identifier": "other", "authTag": tag,
            }),
            ServiceInstance("phone", None, 49152, [Address("fe80::2", "VPN"), Address("192.0.2.2", "LAN")], {
                "identifier": "phone", "authTag": tag,
            }),
        ]
        ips = [
            SimpleNamespace(ip="192.0.2.1", network_prefix=24, is_IPv4=True, is_IPv6=False),
            SimpleNamespace(ip=("fe80::1", 0, 10), is_IPv4=False, is_IPv6=True),
        ]
        attempted = []

        async def connect(_udid, host, _port, **opts):
            self.assertFalse(opts["autopair"])
            attempted.append(host)
            return host

        class Tunnel:
            def __init__(self, provider_factory):
                self.provider_factory = provider_factory

            async def aopen(self):
                provider = await self.provider_factory()
                if provider.service == "192.0.2.2":
                    raise TimeoutError()
                return "connected RSD"

        original_connect = bridge.tunnel_service.create_connection
        with (
            patch.object(sys, "platform", "win32"),
            patch("ifaddr.get_adapters", return_value=[SimpleNamespace(ips=ips)]),
            patch.object(bridge.pmd_pair_records, "get_local_pairing_record", return_value={"peer_alt_irk": key}),
            patch.object(bridge, "browse_remotepairing", AsyncMock(return_value=answers)),
            patch.object(bridge.tunnel_service, "create_core_device_tunnel_service_using_remotepairing", connect),
            patch.object(bridge.userspace_tunnel, "UserspaceRsdTunnel", Tunnel),
        ):
            rsd, _ = await bridge._open_remote_tunnel("test")
        self.assertEqual(rsd, "connected RSD")
        self.assertEqual(attempted, ["192.0.2.2", "fe80::2%10"])
        self.assertIs(bridge.tunnel_service.create_connection, original_connect)


if __name__ == "__main__":
    unittest.main()
