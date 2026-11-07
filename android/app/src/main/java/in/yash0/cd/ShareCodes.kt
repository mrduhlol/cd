package `in`.yash0.cd

import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Request
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.TimeUnit

object ShareCodes {
    private val codePattern = Regex("[0-9]{4,5}")
    fun lookupUrl(raw: String): String? {
        if (raw.matches(codePattern)) return "https://cd.yash0.in/api/codes/$raw"
        val uri = runCatching { URI(raw) }.getOrNull() ?: return null
        if (uri.rawFragment?.matches(codePattern) != true) return null
        require(uri.userInfo == null && uri.rawQuery == null && uri.path in listOf("", "/")) { "Invalid CD code link" }
        val relay = "${if (uri.scheme == "https") "wss" else "ws"}://${uri.rawAuthority}"
        require(uri.scheme in listOf("https", "http") && validEndpoint(relay)) { "Use a secure CD link" }
        return "${uri.scheme}://${uri.rawAuthority}/api/codes/${uri.rawFragment}"
    }
    fun claim(client: OkHttpClient, origin: String, id: String, key: String, senderToken: String): Pair<String, Long> {
        val body = JSONObject().put("transferId", id).put("key", key).put("version", 2).put("senderToken", senderToken)
        val request = Request.Builder().url("${origin.trimEnd('/')}/api/codes")
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        return client.newBuilder().callTimeout(15, TimeUnit.SECONDS).followRedirects(false).build().newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw SendProblem(SendFailureKind.CODE_UNAVAILABLE)
            val source = response.body?.source() ?: error("Empty code response")
            source.request(4097)
            require(source.buffer.size <= 4096) { "Invalid code response" }
            val result = JSONObject(source.buffer.readUtf8())
            val code = result.getString("code")
            val expiry = result.getLong("expiresAt")
            require(code.matches(Regex("[0-9]{5}"))) { "Invalid share code" }
            if (expiry <= System.currentTimeMillis()) throw SendProblem(SendFailureKind.CLOCK)
            code to expiry
        }
    }
    fun resolve(lookup: String): String {
        val client = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).followRedirects(false).build()
        return client.newCall(Request.Builder().url(lookup).build()).execute().use { response ->
            require(response.isSuccessful) { if (response.code == 429) "Too many code attempts. Wait a minute and try again." else "Code expired or sender unavailable. Ask for a new code." }
            val source = response.body?.source() ?: error("Empty code response")
            source.request(4097)
            require(source.buffer.size <= 4096) { "Invalid code response" }
            val bytes = source.buffer.readByteArray()
            val value = JSONObject(String(bytes))
            val id = value.getString("transferId")
            val key = value.getString("key")
            Crypto.decode(id, 16); Crypto.decode(key, 32)
            val lookupOrigin = URI(lookup).let { "${it.scheme}://${it.rawAuthority}" }
            val origin = value.optString("origin", lookupOrigin)
            require(origin == lookupOrigin || origin == "https://cdx.yash0.in") { "Invalid transfer origin" }
            val version = value.optInt("version", 1)
            require(version in 1..2) { "Unsupported transfer version" }
            "$origin/s/$id#${if (version == 2) "v2." else ""}$key"
        }
    }
}
