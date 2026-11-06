package `in`.yash0.cd

object NativeNetworkPolicy {
    fun allowed(allowMobile: Boolean, wifi: Boolean, ethernet: Boolean, cellular: Boolean, vpn: Boolean, unmetered: Boolean): Boolean =
        allowMobile || ((wifi || ethernet) && !cellular && !vpn && unmetered)
    fun sameSubnet(source: ByteArray, destination: ByteArray, prefix: Int): Boolean {
        if (source.size != destination.size || prefix !in 1..(source.size * 8)) return false
        return source.indices.all { i ->
            val bits = (prefix - i * 8).coerceIn(0, 8)
            val mask = (255 shl (8 - bits)) and 255
            (source[i].toInt() and mask) == (destination[i].toInt() and mask)
        }
    }
    // Matches the public PeerConnectionFactory.Options constants, verified against the pinned AAR.
    fun ignoreMask(allowMobile: Boolean): Int = if (allowMobile) 0 else (1 or 2).inv()
}
