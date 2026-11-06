package `in`.yash0.cd

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DownloadRequestTest {
    private val fixture = JSONObject(javaClass.classLoader!!.getResource("resume-v2.json")!!.readText()).getJSONObject("invitation")
    private val id = fixture.getString("rootId")
    private val url = "https://cd.yash0.in/s/$id#v2.${fixture.getString("masterKey")}"

    @Test fun acceptedPrivateLinkCreatesBackgroundQueueEntry() {
        val request = DownloadRequest.parse(" $url \n")
        assertEquals(id, request.invitation!!.id)
        val task = request.queuedTask(null)
        assertEquals(id, task.getString("id"))
        assertEquals(url, task.getString("url"))
        assertEquals("queued", task.getString("state"))
        assertFalse(task.has("pairId"))
    }
    @Test fun resumePreservesRetainedMetadataWithoutMutatingPriorState() {
        val previous = JSONObject().put("id", id).put("url", url).put("state", "paused").put("filename", "report.pdf").put("error", "offline")
        val next = DownloadRequest.parse(url).queuedTask(previous)
        assertEquals("queued", next.getString("state"))
        assertEquals("report.pdf", next.getString("filename"))
        assertFalse(next.has("error"))
        assertEquals("paused", previous.getString("state"))
        assertEquals("offline", previous.getString("error"))
    }
    @Test fun duplicateAcceptanceKeepsActiveTransferRunning() {
        val previous = JSONObject().put("id", id).put("url", url).put("state", "receiving")
        assertEquals("receiving", DownloadRequest.parse(url).queuedTask(previous).getString("state"))
    }
    @Test fun cannotReplaceSavedCancelledOrDifferentPrivateTransfer() {
        val request = DownloadRequest.parse(url)
        for (state in listOf("complete", "cancelled")) {
            val previous = JSONObject().put("id", id).put("url", url).put("state", state)
            assertThrows(IllegalArgumentException::class.java) { request.queuedTask(previous) }
            assertEquals(state, previous.getString("state"))
        }
        val previous = JSONObject().put("id", id).put("url", url.replace("cd.yash0.in", "another.example")).put("state", "paused")
        assertThrows(IllegalArgumentException::class.java) { request.queuedTask(previous) }
    }
    @Test fun ordinaryLinksAndShortCodesCreateUnpairedQueueEntries() {
        assertEquals(1, DownloadRequest.parse(url.replace("v2.", "v1.")).invitation!!.version)
        for (raw in listOf("12345", "https://cd.yash0.in/#12345", "http://cd.yash0.in/#12345")) {
            val request = DownloadRequest.parse(raw)
            assertNull(request.invitation)
            assertEquals("12345", request.code)
            val task = request.queuedTask(null)
            assertEquals("queued", task.getString("state"))
            assertEquals("12345", task.getString("code"))
            assertFalse(task.getBoolean("resumable"))
            val body = JSONObject().put("transferId", id).put("key", fixture.getString("masterKey"))
            assertEquals(url.replace("v2.", "v1."), request.resolveCapability(body))
            body.put("origin", "https://cdx.yash0.in")
            assertEquals(url.replace("v2.", "v1.").replace("cd.yash0.in", "cdx.yash0.in"), request.resolveCapability(body))
            body.put("origin", "https://attacker.example")
            assertThrows(IllegalArgumentException::class.java) { request.resolveCapability(body) }
            body.put("origin", "https://cd.yash0.in").put("key", "bad")
            assertThrows(IllegalArgumentException::class.java) { request.resolveCapability(body) }
        }
    }
    @Test fun invalidAndUnsupportedLinksCannotBecomeDownloadTasks() {
        for (raw in listOf("https://cd.yash0.in/", "https://cd.yash0.in/#p2p.river-brave", url.replace("https://", "http://"), url.replace("#v2.", "?key=v2."))) {
            assertThrows(IllegalArgumentException::class.java) { DownloadRequest.parse(raw) }
        }
    }
}
