package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory

class NativeNetworkPolicyTest {
    @Test fun optOutPublishesOnlyUnmeteredWifiAndEthernetHandles() {
        assertTrue(NativeNetworkPolicy.allowed(false, true, false, false, false, true))
        assertTrue(NativeNetworkPolicy.allowed(false, false, true, false, false, true))
        assertFalse(NativeNetworkPolicy.allowed(false, true, false, true, false, true))
        assertFalse(NativeNetworkPolicy.allowed(false, true, false, false, true, true))
        assertFalse(NativeNetworkPolicy.allowed(false, true, false, false, false, false))
        assertFalse(NativeNetworkPolicy.allowed(false, false, false, false, false, true))
        assertTrue(NativeNetworkPolicy.allowed(true, false, false, true, true, false))
    }
    @Test fun localBindingRequiresTheDestinationToBeOnTheSameSubnet() {
        val phone = byteArrayOf(10, 141.toByte(), 148.toByte(), 232.toByte())
        assertTrue(NativeNetworkPolicy.sameSubnet(phone, byteArrayOf(10, 141.toByte(), 148.toByte(), 235.toByte()), 24))
        assertFalse(NativeNetworkPolicy.sameSubnet(phone, byteArrayOf(10, 141.toByte(), 149.toByte(), 235.toByte()), 24))
        assertFalse(NativeNetworkPolicy.sameSubnet(phone, byteArrayOf(8, 8, 8, 8), 24))
        assertFalse(NativeNetworkPolicy.sameSubnet(phone, ByteArray(16), 24))
        assertFalse(NativeNetworkPolicy.sameSubnet(phone, phone, 0))
    }
    @Test fun nativeIgnoreMaskExcludesEveryCellularGenerationVpnAndWildcardAdapters() {
        assertEquals(1, PeerConnectionFactory.Options.ADAPTER_TYPE_ETHERNET)
        assertEquals(2, PeerConnectionFactory.Options.ADAPTER_TYPE_WIFI)
        val mask = NativeNetworkPolicy.ignoreMask(false)
        assertEquals(0, mask and PeerConnection.AdapterType.WIFI.bitMask)
        assertEquals(0, mask and PeerConnection.AdapterType.ETHERNET.bitMask)
        listOf(PeerConnection.AdapterType.CELLULAR, PeerConnection.AdapterType.CELLULAR_2G, PeerConnection.AdapterType.CELLULAR_3G, PeerConnection.AdapterType.CELLULAR_4G, PeerConnection.AdapterType.CELLULAR_5G, PeerConnection.AdapterType.VPN, PeerConnection.AdapterType.LOOPBACK, PeerConnection.AdapterType.ADAPTER_TYPE_ANY).forEach { type -> assertNotEquals(type.name, 0, mask and type.bitMask) }
        assertEquals(0, NativeNetworkPolicy.ignoreMask(true))
    }
}
