package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test

class PushPolicyTest {
    private val id = "abcdefghijklmnopqrstuv"
    private val now = 1800000000000L
    private fun data(issuedAt: String = now.toString(), pair: String = id) = mapOf("v" to "1", "type" to "wake", "pairId" to pair, "issuedAt" to issuedAt)
    private fun decide(payload: Map<String, String> = data(), optIn: Boolean = true, receiving: Boolean = true, notifications: Boolean = true, high: Boolean = true) = PushPolicy.decide(payload, now, setOf(id), optIn, receiving, notifications, high)
    @Test fun onlyDeliveredHighPriorityCanStartReceiver() {
        assertEquals(PushPolicy.Action.START_RECEIVER, decide())
        assertEquals(PushPolicy.Action.SHOW_NOTIFICATION, decide(high = false))
        assertEquals(PushPolicy.Action.IGNORE, decide(optIn = false))
        assertEquals(PushPolicy.Action.IGNORE, decide(receiving = false))
        assertEquals(PushPolicy.Action.IGNORE, decide(notifications = false))
        assertEquals(PushPolicy.Action.IGNORE, decide(data(pair = "revoked-or-unknown")))
    }
    @Test fun rejectsStaleMalformedAndUnexpectedContent() {
        assertEquals(PushPolicy.Action.START_RECEIVER, decide(data((now - 300000).toString())))
        assertEquals(PushPolicy.Action.IGNORE, decide(data((now - 300001).toString())))
        assertEquals(PushPolicy.Action.START_RECEIVER, decide(data((now + 30000).toString())))
        assertEquals(PushPolicy.Action.IGNORE, decide(data((now + 30001).toString())))
        for (issued in listOf("", "bad", "1e12", "-1", "99999999999999999")) assertEquals(PushPolicy.Action.IGNORE, decide(data(issued)))
        assertEquals(PushPolicy.Action.IGNORE, decide(data() + ("v" to "2")))
        assertEquals(PushPolicy.Action.IGNORE, decide(data() + ("type" to "download")))
        assertEquals(PushPolicy.Action.IGNORE, decide(data() + ("url" to "https://attacker.invalid/file")))
        assertEquals(PushPolicy.Action.IGNORE, decide(data() - "pairId"))
    }
    @Test fun duplicateAndRapidHintsCannotRepeatedlyRestartReceiver() {
        assertTrue(PushPolicy.acceptWake(0, 0, now, now))
        assertFalse(PushPolicy.acceptWake(now, now, now, now + 30000))
        assertFalse(PushPolicy.acceptWake(now, now, now - 1, now + 30000))
        assertFalse(PushPolicy.acceptWake(now, now, now + 1000, now + 19999))
        assertTrue(PushPolicy.acceptWake(now, now, now + 1000, now + 20000))
        assertFalse(PushPolicy.acceptWake(now, now, now + 1000, now - 1000))
    }
    @Test fun credentialsOnlyGoToTlsRelayOriginOrExplicitLoopback() {
        assertEquals("https://relay.example:9443/api/devices/v1/$id/push-target", PushPolicy.targetUrl("wss://relay.example:9443/ws/devices/v1/$id", id))
        assertEquals("http://127.0.0.1:8787/api/devices/v1/$id/push-target", PushPolicy.targetUrl("ws://127.0.0.1:8787/ws/devices/v1/$id", id))
        assertEquals("http://[::1]:8787/api/devices/v1/$id/push-target", PushPolicy.targetUrl("ws://[::1]:8787/ws/devices/v1/$id", id))
        for (relay in listOf("ws://192.168.1.8/ws", "ws://10.0.2.2/ws", "https://relay.example/ws", "wss://user:password@relay.example/ws", "wss://relay.example/ws?token=x", "wss://relay.example/ws#fragment")) assertThrows(IllegalArgumentException::class.java) { PushPolicy.targetUrl(relay, id) }
        assertThrows(IllegalArgumentException::class.java) { PushPolicy.targetUrl("wss://relay.example/ws", "../bad") }
    }
}
