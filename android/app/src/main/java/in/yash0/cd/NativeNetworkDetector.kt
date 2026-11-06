package `in`.yash0.cd

import android.content.Context
import android.net.*
import org.webrtc.NetworkChangeDetector
import java.util.concurrent.ConcurrentHashMap

/** Supplies only permitted Android network handles to libwebrtc's native socket binder. */
class NativeNetworkDetector(private val observer: NetworkChangeDetector.Observer, context: Context): NetworkChangeDetector {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val store = StoreRegistry.get(context)
    private val published = HashMap<Long, NetworkChangeDetector.NetworkInformation>()
    private var destroyed = false
    private var registered = false
    private val callback = object: ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = refresh()
        override fun onLost(network: Network) = refresh()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = refresh()
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) = refresh()
    }
    init {
        // Unlike NetworkMonitorAutoDetect, this detector never requests a cellular network.
        registered = runCatching { cm.registerNetworkCallback(NetworkRequest.Builder().removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).removeCapability(NetworkCapabilities.NET_CAPABILITY_TRUSTED).removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED).build(), callback); true }.getOrDefault(false)
        instances.add(this)
    }
    private fun info(network: Network): NetworkChangeDetector.NetworkInformation? {
        val caps = cm.getNetworkCapabilities(network) ?: return null
        if (!NativeNetworkPolicy.allowed(store.allowedMobile(), caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI), caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET), caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR), caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN), caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))) return null
        val link = cm.getLinkProperties(network) ?: return null
        val name = link.interfaceName?.takeIf { it.isNotEmpty() } ?: return null
        val addresses = link.linkAddresses.map { NetworkChangeDetector.IPAddress(it.address.address) }.toTypedArray()
        if (addresses.isEmpty()) return null
        val type = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> NetworkChangeDetector.ConnectionType.CONNECTION_VPN
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> NetworkChangeDetector.ConnectionType.CONNECTION_UNKNOWN_CELLULAR
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> NetworkChangeDetector.ConnectionType.CONNECTION_WIFI
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> NetworkChangeDetector.ConnectionType.CONNECTION_ETHERNET
            else -> NetworkChangeDetector.ConnectionType.CONNECTION_UNKNOWN
        }
        return NetworkChangeDetector.NetworkInformation(name, type, NetworkChangeDetector.ConnectionType.CONNECTION_UNKNOWN, network.networkHandle, addresses, NetworkChangeDetector.NetworkSlice.NO_SLICE)
    }
    @Suppress("DEPRECATION") override fun getActiveNetworkList(): List<NetworkChangeDetector.NetworkInformation> = synchronized(this) {
        if (!registered || destroyed) emptyList() else cm.allNetworks.mapNotNull(::info)
    }
    override fun getCurrentConnectionType(): NetworkChangeDetector.ConnectionType = getActiveNetworkList().firstOrNull()?.type ?: NetworkChangeDetector.ConnectionType.CONNECTION_NONE
    override fun supportNetworkCallback(): Boolean = true
    @Synchronized fun refresh() {
        if (destroyed) return
        val next = getActiveNetworkList().associateBy { it.handle }
        (published.keys - next.keys).forEach { observer.onNetworkDisconnect(it) }
        next.values.forEach { observer.onNetworkConnect(it) }
        published.clear(); published.putAll(next)
        observer.onConnectionTypeChanged(next.values.firstOrNull()?.type ?: NetworkChangeDetector.ConnectionType.CONNECTION_NONE)
    }
    @Synchronized override fun destroy() {
        destroyed = true
        if (registered) runCatching { cm.unregisterNetworkCallback(callback) }
        registered = false; published.clear(); instances.remove(this)
    }
    companion object {
        private val instances: MutableSet<NativeNetworkDetector> = ConcurrentHashMap.newKeySet()
        fun refreshPolicy() { instances.forEach { it.refresh() } }
    }
}
