package `in`.yash0.cd

import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.MockResponse
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ShareCodesTest {
    @Test fun resumableCodeClaimAndResolutionUseVersionAndSenderProof() {
        val id = Crypto.encode(ByteArray(16) { 1 })
        val key = Crypto.encode(ByteArray(32) { 2 })
        val token = Crypto.encode(ByteArray(32) { 3 })
        val expiry = System.currentTimeMillis() + 900000
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(JSONObject().put("code", "01234").put("expiresAt", expiry).toString()))
        server.enqueue(MockResponse().setBody(JSONObject().put("transferId", id).put("key", key).put("version", 2).toString()))
        server.start()
        try {
            val origin = server.url("/").toString().removeSuffix("/")
            assertEquals("01234" to expiry, ShareCodes.claim(OkHttpClient(), origin, id, key, token))
            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/api/codes", request.path)
            val submitted = JSONObject(request.body.readUtf8())
            assertEquals(2, submitted.getInt("version"))
            assertEquals(token, submitted.getString("senderToken"))
            assertEquals(key, submitted.getString("key"))
            assertEquals("$origin/s/$id#v2.$key", ShareCodes.resolve("$origin/api/codes/01234"))
        } finally { server.shutdown() }
    }
    @Test fun legacyCodeOriginsAreAllowedButArbitraryRedirectsAreRejected() {
        val id = Crypto.encode(ByteArray(16) { 1 })
        val key = Crypto.encode(ByteArray(32) { 2 })
        val server = MockWebServer()
        server.start()
        try {
            val body = JSONObject().put("transferId", id).put("key", key).put("origin", "https://cdx.yash0.in")
            server.enqueue(MockResponse().setBody(body.toString()))
            assertEquals("https://cdx.yash0.in/s/$id#$key", ShareCodes.resolve(server.url("/api/codes/12345").toString()))
            server.enqueue(MockResponse().setBody(body.put("origin", "https://attacker.example").toString()))
            assertThrows(IllegalArgumentException::class.java) { ShareCodes.resolve(server.url("/api/codes/12345").toString()) }
        } finally { server.shutdown() }
    }
}
