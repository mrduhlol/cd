package `in`.yash0.cd

import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PushTargetTest {
    @Test fun registrationUsesReceiverCredentialFromSharedFixtureAndDeleteHasNoFid() {
        val fixture = JSONObject(javaClass.classLoader!!.getResource("device-v1.json")!!.readText())
        val pair = Pairing(fixture.getJSONObject("pair"))
        val fid = "cABCDEFGHIJKLMNOPQRSTU"
        val post = PushTarget.request(pair.json.getString("relayUrl"), pair.id, pair.token(), fid)
        assertEquals("POST", post.method)
        assertEquals("https://cd.yash0.in/api/devices/v1/${pair.id}/push-target", post.url.toString())
        val body = JSONObject(Buffer().apply { post.body!!.writeTo(this) }.readUtf8())
        assertEquals(setOf("v", "token", "fid"), body.keys().asSequence().toSet())
        assertEquals(1, body.getInt("v"))
        assertEquals(fid, body.getString("fid"))
        assertEquals(fixture.getString("receiverToken"), body.getString("token"))
        assertNotEquals(fixture.getString("senderToken"), body.getString("token"))
        val delete = PushTarget.request(pair.json.getString("relayUrl"), pair.id, pair.token(), null)
        assertEquals("DELETE", delete.method)
        val deletion = JSONObject(Buffer().apply { delete.body!!.writeTo(this) }.readUtf8())
        assertEquals(setOf("v", "token"), deletion.keys().asSequence().toSet())
        assertEquals(fixture.getString("receiverToken"), deletion.getString("token"))
        assertThrows(IllegalArgumentException::class.java) { PushTarget.request(pair.json.getString("relayUrl"), pair.id, pair.token(), "bad-fid") }
    }
}
