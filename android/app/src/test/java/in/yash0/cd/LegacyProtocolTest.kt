package `in`.yash0.cd

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class LegacyProtocolTest {
    @Test fun legacyFramesMatchIndependentFixtureAndRejectReplay() {
        val fixture = JSONObject(javaClass.classLoader!!.getResource("transfer-v1.json")!!.readText())
        val invitation = Invitation.parse("https://cd.yash0.in/s/${fixture.getString("id")}#${fixture.getString("key")}")
        assertEquals(1, invitation.version)
        val prefixed = Invitation.parse("https://cd.yash0.in/s/${fixture.getString("id")}#v1.${fixture.getString("key")}")
        assertEquals(invitation.id, prefixed.id)
        assertEquals(invitation.relay, prefixed.relay)
        assertArrayEquals(invitation.key, prefixed.key)
        assertEquals(fixture.getString("token"), Crypto.encode(invitation.token()))
        val sender = Base64.getUrlDecoder().decode(fixture.getString("sender"))
        val receiver = Base64.getUrlDecoder().decode(fixture.getString("receiver"))
        assertArrayEquals(sender, Records(invitation, byteArrayOf(), byteArrayOf(), true).seal(2, "exact bytes".toByteArray()))
        assertArrayEquals(receiver, Records(invitation, byteArrayOf(), byteArrayOf(), false).seal(4, "exact bytes".toByteArray()))
        val opener = Records(invitation, byteArrayOf(), byteArrayOf(), true)
        assertEquals("exact bytes", String(opener.open(sender).second))
        assertThrows(Exception::class.java) { opener.open(sender) }
        sender[sender.lastIndex] = (sender.last().toInt() xor 1).toByte()
        assertThrows(Exception::class.java) { Records(invitation, byteArrayOf(), byteArrayOf(), true).open(sender) }
    }
    @Test fun codeLookupKeepsOriginAndRejectsUnsafeURLs() {
        assertEquals("https://cd.yash0.in/api/codes/12345", ShareCodes.lookupUrl("12345"))
        assertEquals("https://cd-test.yash0.in/api/codes/1234", ShareCodes.lookupUrl("https://cd-test.yash0.in/#1234"))
        assertNull(ShareCodes.lookupUrl("not a code"))
        assertThrows(Exception::class.java) { ShareCodes.lookupUrl("http://example.com/#1234") }
        assertThrows(Exception::class.java) { ShareCodes.lookupUrl("https://user@example.com/#1234") }
    }
}
