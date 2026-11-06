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
    @Test fun dismissedTerminalReceiveRejectsReoffersWithFreshMessageIds() {
        val now = 1_800_000_000_000L
        for (state in listOf("complete", "cancelled", "failed")) {
            val root = JSONObject().put("tasks", JSONObject()).put("replays", JSONObject())
            val offer = JSONObject(javaClass.classLoader!!.getResource("device-v1.json")!!.readText()).getJSONObject("offer")
                .put("messageId", "original-message").put("expiresAt", now + 300000).put("dismissedUntil", now + 999999)
            val id = offer.getString("transferId")
            assertTrue(addReceiveOffer(root, "trusted-pair", offer, now = now))
            assertFalse(root.getJSONObject("tasks").getJSONObject(id).has("dismissedUntil"))
            root.getJSONObject("tasks").getJSONObject(id).put("state", state).put("publishedUri", "content://downloads/42")
            assertTrue(dismissReceiveTask(root, id, now))
            val freshOffer = JSONObject(offer.toString()).put("messageId", "fresh-authenticated-message")
            assertFalse(addReceiveOffer(root, "trusted-pair", freshOffer, now = now + 1))
            val retained = root.getJSONObject("tasks").getJSONObject(id)
            assertEquals(state, retained.getString("state"))
            assertEquals("content://downloads/42", retained.getString("publishedUri"))
            assertEquals(now + 24 * 60 * 60 * 1000L, retained.getLong("dismissedUntil"))
            TransferBus.remove(id, Direction.RECEIVE)
            ReceiveViews.publish(retained, force = true)
            assertFalse(TransferBus.transfers.value.any { it.id == id && it.direction == Direction.RECEIVE })
        }
    }

    @Test fun dismissedTombstonesExpireWithoutPruningActiveTransfers() {
        val now = 1_800_000_000_000L
        val root = JSONObject().put("tasks", JSONObject()).put("replays", JSONObject())
        val offer = JSONObject(javaClass.classLoader!!.getResource("device-v1.json")!!.readText()).getJSONObject("offer")
            .put("messageId", "first").put("expiresAt", now + 300000)
        val id = offer.getString("transferId")
        assertTrue(addReceiveOffer(root, "trusted-pair", offer, now = now))
        root.getJSONObject("tasks").getJSONObject(id).put("state", "cancelled")
        root.getJSONObject("tasks").put("active-transfer", JSONObject().put("state", "receiving"))
        assertTrue(dismissReceiveTask(root, id, now))
        val later = now + 24 * 60 * 60 * 1000L
        val fresh = JSONObject(offer.toString()).put("messageId", "after-retention").put("expiresAt", later + 300000)
        assertTrue(addReceiveOffer(root, "trusted-pair", fresh, now = later))
        assertEquals("queued", root.getJSONObject("tasks").getJSONObject(id).getString("state"))
        assertEquals("receiving", root.getJSONObject("tasks").getJSONObject("active-transfer").getString("state"))
    }

}
