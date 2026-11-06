package `in`.yash0.cd

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import java.util.concurrent.ConcurrentHashMap
import okhttp3.Dns
import okhttp3.OkHttpClient
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URI
import javax.net.SocketFactory

/** Local sockets bind to a directly connected address, including a phone's hotspot.
 * Public sockets still require an explicitly permitted Android network. */
class ReceiverNetwork(context: Context, private val store: Store) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val discovered = ConcurrentHashMap.newKeySet<Network>()
    private val localCallback = object: ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { discovered.add(network) }
        override fun onLost(network: Network) { discovered.remove(network) }
    }
    private val registered = Build.VERSION.SDK_INT >= 35 && runCatching {
        cm.registerNetworkCallback(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_LOCAL_NETWORK).build(), localCallback)
        true
    }.getOrDefault(false)
    @Suppress("DEPRECATION") private fun networks(): List<Network> = (cm.allNetworks.toList() + discovered).distinct()
    fun close() { if (registered) runCatching { cm.unregisterNetworkCallback(localCallback) } }
    @Suppress("DEPRECATION")
    private fun publicNetwork(): Network? = networks().firstOrNull { network ->
        val c = cm.getNetworkCapabilities(network) ?: return@firstOrNull false
        c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && NativeNetworkPolicy.allowed(store.allowedMobile(), c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI), c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET), c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR), c.hasTransport(NetworkCapabilities.TRANSPORT_VPN), c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
    }
    @Suppress("DEPRECATION")
    private fun localAddress(endpoint: String): InetAddress? {
        if (!localEndpoint(endpoint)) return null
        val destination = InetAddress.getByName(URI(endpoint).host)
        if (destination.isLoopbackAddress) return destination
        val excluded = networks().filter { network ->
            val c = cm.getNetworkCapabilities(network)
            c != null && (c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) || c.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
        }.mapNotNull { cm.getLinkProperties(it)?.interfaceName }.toSet()
        return NetworkInterface.getNetworkInterfaces()?.toList()?.asSequence()
            ?.filter { it.isUp && !it.isLoopback && it.name !in excluded }
            ?.flatMap { it.interfaceAddresses.asSequence() }
            ?.firstOrNull { NativeNetworkPolicy.sameSubnet(it.address.address, destination.address, it.networkPrefixLength.toInt()) }?.address
    }
    @Suppress("DEPRECATION")
    private fun localNetwork(endpoint: String): Network? {
        if (!localEndpoint(endpoint)) return null
        val destination = InetAddress.getByName(URI(endpoint).host)
        return networks().firstOrNull { network ->
            val c = cm.getNetworkCapabilities(network) ?: return@firstOrNull false
            !c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) && !c.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                cm.getLinkProperties(network)?.linkAddresses?.any {
                    NativeNetworkPolicy.sameSubnet(it.address.address, destination.address, it.prefixLength)
                } == true
        }
    }
    fun allowed(endpoint: String): Boolean = validEndpoint(endpoint) && (localNetwork(endpoint) != null || localAddress(endpoint) != null || publicNetwork() != null)
    fun client(base: OkHttpClient, endpoint: String): OkHttpClient {
        if (!validEndpoint(endpoint)) throw IOException("Invalid endpoint")
        localNetwork(endpoint)?.let { return base.newBuilder().socketFactory(it.socketFactory).followRedirects(false).followSslRedirects(false).build() }
        val local = localAddress(endpoint)
        if (local != null) return base.newBuilder().socketFactory(BoundSockets(local)).followRedirects(false).followSslRedirects(false).build()
        val network = publicNetwork() ?: throw TransientNetworkException()
        return base.newBuilder().socketFactory(network.socketFactory).dns(object: Dns {
            override fun lookup(hostname: String): List<InetAddress> = network.getAllByName(hostname).toList()
        }).build()
    }
    private class BoundSockets(private val source: InetAddress): SocketFactory() {
        override fun createSocket(): Socket = Socket().apply { bind(InetSocketAddress(source, 0)) }
        override fun createSocket(host: String, port: Int): Socket = createSocket().apply { connect(InetSocketAddress(host, port)) }
        override fun createSocket(host: InetAddress, port: Int): Socket = createSocket().apply { connect(InetSocketAddress(host, port)) }
        override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket = createSocket(host, port)
        override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket = createSocket(host, port)
    }
}
