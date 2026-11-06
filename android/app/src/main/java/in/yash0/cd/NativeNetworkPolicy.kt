package `in`.yash0.cd

object NativeNetworkPolicy {
    fun allowed(allowMobile: Boolean, wifi: Boolean, ethernet: Boolean, cellular: Boolean, vpn: Boolean, unmetered: Boolean): Boolean =
        allowMobile || ((wifi || ethernet) && !cellular && !vpn && unmetered)
    // Matches the public PeerConnectionFactory.Options constants, verified against the pinned AAR.
    fun ignoreMask(allowMobile: Boolean): Int = if (allowMobile) 0 else (1 or 2).inv()
}
