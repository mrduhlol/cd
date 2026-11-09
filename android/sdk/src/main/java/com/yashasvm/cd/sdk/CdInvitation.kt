package com.yashasvm.cd.sdk

import java.net.URI
import java.util.Base64

/** A one-recipient invitation. Treat it like a secret until it expires or is used. */
data class CdInvitation internal constructor(
    internal val transferId: ByteArray,
    internal val key: ByteArray,
    val url: String,
) {
    override fun toString(): String = url

    companion object {
        internal fun create(origin: String, random: ByteArray = ByteArray(48).also { java.security.SecureRandom().nextBytes(it) }): CdInvitation {
            require(random.size == 48)
            val id = random.copyOfRange(0, 16)
            val key = random.copyOfRange(16, 48)
            val encodedId = encode(id)
            val encodedKey = encode(key)
            return CdInvitation(id, key, "${origin.trimEnd('/')}/s/$encodedId#v1.$encodedKey")
        }

        internal fun parse(raw: String, expectedOrigin: String): CdInvitation {
            val uri = URI(raw)
            val expected = URI(expectedOrigin)
            require(uri.scheme == expected.scheme && uri.host.equals(expected.host, ignoreCase = true) && uri.port == expected.port)
            require(uri.userInfo == null && uri.query == null)
            val pathMatch = requireNotNull(Regex("^/s/([A-Za-z0-9_-]{22})/?$").matchEntire(uri.path)) { "Invalid CD invitation path" }
            val keyMatch = requireNotNull(Regex("^v1\\.([A-Za-z0-9_-]{43})$").matchEntire(uri.rawFragment ?: "")) { "Invalid CD invitation key" }
            val id = decode(pathMatch.groupValues[1], 16)
            val key = decode(keyMatch.groupValues[1], 32)
            return CdInvitation(id, key, raw)
        }

        internal fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

        internal fun decode(value: String, size: Int): ByteArray {
            val bytes = Base64.getUrlDecoder().decode(value)
            require(bytes.size == size && encode(bytes) == value) { "Invalid CD invitation credential" }
            return bytes
        }
    }
}
