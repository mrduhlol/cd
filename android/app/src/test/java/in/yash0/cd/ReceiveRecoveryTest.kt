package `in`.yash0.cd

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReceiveRecoveryTest {
    private fun task(state: String, resumable: Boolean) = JSONObject().put("state", state).put("resumable", resumable)

    @Test fun interruptedOrdinaryTransfersNeedANewSenderSession() {
        for (state in listOf("connecting", "receiving", "verifying", "retrying")) {
            val recovered = recoverReceiveTask(task(state, false))!!
            assertEquals("failed", recovered.getString("state"))
            assertEquals("Transfer interrupted. Ask the sender for a new link or code.", recovered.getString("error"))
        }
    }

    @Test fun resumableTransfersRequeueWithoutLosingTheirCheckpoint() {
        val original = task("receiving", true).put("received", 262144).put("url", "retained-private-link")
        val recovered = recoverReceiveTask(original)!!
        assertEquals("queued", recovered.getString("state"))
        assertEquals(262144, recovered.getInt("received"))
        assertEquals("retained-private-link", recovered.getString("url"))
        assertEquals("receiving", original.getString("state"))
    }

    @Test fun queuedAndUserStoppedAndFinishedTasksAreUntouched() {
        for (state in listOf("queued", "paused", "cancelled", "complete", "failed")) {
            for (resumable in listOf(true, false)) assertNull(recoverReceiveTask(task(state, resumable)))
        }
    }

    @Test fun completedFailedAndStoppedHistoryDoesNotFillTheReceiveQueue() {
        val history = List(30) { task(listOf("complete", "failed", "cancelled", "paused")[it % 4], false) }
        assertTrue(receiveQueueHasRoom(history))
        assertTrue(receiveQueueHasRoom(history + List(15) { task("queued", true) }))
        assertFalse(receiveQueueHasRoom(history + List(16) { task("queued", true) }))
        assertFalse(receiveQueueHasRoom(List(16) { task(listOf("queued", "connecting", "receiving", "verifying", "retrying")[it % 5], true) }))
    }

    @Test fun dismissNeverRemovesAnActiveOrResumablePausedReceive() {
        for (state in listOf("queued", "connecting", "receiving", "verifying", "retrying", "paused")) assertFalse(canDismissReceive(state))
        for (state in listOf("complete", "cancelled", "failed")) assertTrue(canDismissReceive(state))
    }
    @Test fun oldTasksInferResumeSupportFromTheirPrivateLink() {
        val url = "https://cd.yash0.in/s/AAECAwQFBgcICQoLDA0ODw#v1.ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"
        assertFalse(receiveCanResume(JSONObject().put("url", url)))
        assertTrue(receiveCanResume(JSONObject().put("url", url.replace("v1.", "v2."))))
        assertEquals("failed", recoverReceiveTask(JSONObject().put("url", url).put("state", "receiving"))!!.getString("state"))
    }
}
