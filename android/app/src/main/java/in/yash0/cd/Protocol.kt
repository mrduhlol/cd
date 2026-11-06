package `in`.yash0.cd

import org.json.JSONObject
import java.net.InetAddress
import java.net.URI
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object Crypto {
    fun encode(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun decode(s: String, length: Int): ByteArray {
        val b = Base64.getUrlDecoder().decode(s)
        require(b.size == length && encode(b) == s) { "Invalid encoded credential" }
        return b
    }
    fun random(n: Int): ByteArray = ByteArray(n).also { SecureRandom().nextBytes(it) }
    fun sha(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
    fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it.toInt() and 255) }
    fun hmac(key: ByteArray, b: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(b) }
    fun derive(secret: ByteArray, salt: ByteArray, info: String): ByteArray = hmac(hmac(salt, secret), info.toByteArray() + byteArrayOf(1))
    fun cipher(encrypt: Boolean, key: ByteArray, nonce: ByteArray, aad: ByteArray, bytes: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        updateAAD(aad); doFinal(bytes)
    }
}

fun localEndpoint(raw: String): Boolean = runCatching {
    val u = URI(raw)
    require(u.scheme == "ws" && u.host != null && u.userInfo == null && u.fragment == null)
    val host = u.host.removePrefix("[").removeSuffix("]")
    require(host.matches(Regex("[0-9.]+")) || host.contains(':'))
    val a = InetAddress.getByName(host)
    a.isSiteLocalAddress || a.isLinkLocalAddress || a.isLoopbackAddress
}.getOrDefault(false)

fun validEndpoint(raw: String): Boolean = runCatching {
    val u = URI(raw)
    (u.scheme == "wss" && u.host != null && u.userInfo == null && u.fragment == null) || localEndpoint(raw)
}.getOrDefault(false)

data class Pairing(val json: JSONObject) {
    val id: String get() = json.getString("pairId")
    val name: String get() = json.getString("name")
    val secret: ByteArray get() = Crypto.decode(json.getString("secret"), 32)
    fun key(info: String): ByteArray = Crypto.derive(secret, Crypto.decode(id, 16), "cd-device-v1 $info")
    fun token(): String = Crypto.encode(key("receiver join"))
    fun localProof(nonce: String, role: String = "receiver"): String {
        require(role in listOf("sender", "receiver"))
        Crypto.decode(nonce, 32)
        return Crypto.encode(Crypto.hmac(key("$role local join"), "cd-device-v1 $role $id $nonce".toByteArray()))
    }
    fun seal(message: JSONObject): ByteArray {
        val nonce = Crypto.random(12)
        return nonce + Crypto.cipher(true, key("receiver messages"), nonce, "cd-device-v1 receiver $id".toByteArray(), message.toString().toByteArray())
    }
    fun open(frame: ByteArray, now: Long = System.currentTimeMillis()): JSONObject {
        require(frame.size in 29..16384) { "Invalid control frame length" }
        val msg = JSONObject(String(Crypto.cipher(false, key("sender messages"), frame.copyOfRange(0, 12), "cd-device-v1 sender $id".toByteArray(), frame.copyOfRange(12, frame.size))))
        require(msg.getInt("version") == 1 && msg.getLong("expiresAt") in (now + 1)..(now + 330000)) { "Expired control message" }
        Crypto.decode(msg.getString("messageId"), 16)
        require(msg.getString("type") == "offer") { "Unexpected sender control message" }
        return msg
    }
    companion object {
        fun parse(raw: String, now: Long = System.currentTimeMillis()): Pairing {
            require(raw.length <= 16384)
            val u = URI(raw.trim())
            require(u.scheme == "cdpair" && u.host == "v1" && u.rawQuery == null)
            val j = JSONObject(String(Base64.getUrlDecoder().decode(u.rawFragment)))
            require(j.getInt("version") == 1)
            Crypto.decode(j.getString("pairId"), 16); Crypto.decode(j.getString("secret"), 32)
            require(j.getString("name").length in 1..80)
            require(j.getLong("expiresAt") in (now + 1)..(now + 330000)) { "Pairing expired. Run cdx pair again." }
            val relay = j.getString("relayUrl")
            require(validEndpoint(relay)) { "Pairing requires a secure relay" }
            require(URI(relay).path == "/ws/devices/v1/${j.getString("pairId")}")
            j.optJSONArray("localUrls")?.let { urls -> require(urls.length() <= 16); repeat(urls.length()) { require(localEndpoint(urls.getString(it))) } }
            return Pairing(j)
        }
    }
}

data class Invitation(val id: String, val key: ByteArray, val relay: String, val version: Int = 2) {
    val rawId: ByteArray get() = Crypto.decode(id, 16)
    fun token(): ByteArray = Crypto.derive(key, rawId, "cd-transfer-v$version receiver join")
    fun proof(role: String, nonce: ByteArray): ByteArray = Crypto.hmac(key, "cd-transfer-v2 $role nonce".toByteArray() + rawId + nonce)
    companion object {
        fun parse(raw: String): Invitation {
            val u = URI(raw.trim())
            require(u.scheme == "https" || (u.scheme == "http" && localEndpoint("ws://${u.rawAuthority}${u.path}")))
            require(u.userInfo == null && u.query == null && u.path.matches(Regex("/s/[A-Za-z0-9_-]{22}")))
            val id = u.path.substringAfterLast('/')
            require(u.rawFragment?.matches(Regex("v[12]\\.[A-Za-z0-9_-]{43}")) == true) { "Use a private v1 or v2 CD transfer link" }
            val version = u.rawFragment[1].digitToInt()
            Crypto.decode(id, 16)
            val key = Crypto.decode(u.rawFragment.substring(3), 32)
            val relay = "${if (u.scheme == "https") "wss" else "ws"}://${u.rawAuthority}/ws/v$version/$id"
            require(validEndpoint(relay))
            return Invitation(id, key, relay, version)
        }
    }
}

class Records(private val invitation: Invitation, private val sender: ByteArray, private val receiver: ByteArray, private val fromSender: Boolean) {
    private var sequence = 0L
    private val session = if (invitation.version == 2) sender + receiver else byteArrayOf()
    private val key = Crypto.derive(invitation.key, invitation.rawId + session, "cd-transfer-v${invitation.version} ${if (fromSender) "sender" else "receiver"} frames")
    private fun nonce(): ByteArray = ByteBuffer.allocate(12).put("${if (fromSender) "CDS" else "CDR"}${invitation.version}".toByteArray()).putLong(sequence).array()
    private fun validKind(kind: Int): Boolean = if (fromSender) kind in 1..3 else kind in 4..6 || kind == 9
    fun seal(kind: Int, plaintext: ByteArray): ByteArray {
        require(validKind(kind) && sequence <= 0xffffffffL && plaintext.size <= 1048548)
        val header = ByteBuffer.allocate(12).put('C'.code.toByte()).put('D'.code.toByte()).put(invitation.version.toByte()).put(kind.toByte()).putInt(sequence.toInt()).putInt(plaintext.size).array()
        val out = header + Crypto.cipher(true, key, nonce(), header + invitation.rawId + session, plaintext)
        sequence++; return out
    }
    fun open(record: ByteArray): Pair<Int, ByteArray> {
        require(record.size in 28..1048576)
        val h = ByteBuffer.wrap(record, 0, 12)
        require(h.get() == 'C'.code.toByte() && h.get() == 'D'.code.toByte() && h.get().toInt() == invitation.version)
        val kind = h.get().toInt() and 255
        require(validKind(kind) && h.int.toLong().and(0xffffffffL) == sequence)
        require(h.int == record.size - 28)
        val out = Crypto.cipher(false, key, nonce(), record.copyOfRange(0, 12) + invitation.rawId + session, record.copyOfRange(12, record.size))
        sequence++; return kind to out
    }
}

fun counts(offset: Long): ByteArray = ByteBuffer.allocate(12).putInt(((offset + 262143) / 262144).toInt()).putLong(offset).array()
fun checkpointMac(j: JSONObject, invitation: Invitation): String {
    val fields = listOf("version", "role", "rootId", "filename", "size", "chunkSize", "wholeSha256", "offset", "prefixSha256", "stagingId", "destination", "expiresAt", "priorSessionNonce")
    val bytes = java.io.ByteArrayOutputStream()
    fields.forEach { f -> val b = j.get(f).toString().toByteArray(); bytes.write(ByteBuffer.allocate(4).putInt(b.size).array()); bytes.write(b) }
    return Crypto.encode(Crypto.hmac(Crypto.derive(invitation.key, invitation.rawId, "cd-transfer-v2 receiver checkpoint"), bytes.toByteArray()))
}
