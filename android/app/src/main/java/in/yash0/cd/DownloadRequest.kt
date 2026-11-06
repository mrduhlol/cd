package `in`.yash0.cd

import org.json.JSONObject
import java.net.URI
import java.util.UUID

class DownloadRequest private constructor(val url: String, val invitation: Invitation?, val code: String? = null) {
    fun queuedTask(previous: JSONObject?): JSONObject {
        if (previous != null) {
            require(previous.getString("url") == url) { "This transfer already has a different private link" }
            require(previous.getString("state") != "complete") { "This transfer is already saved in Downloads/CD" }
            require(previous.getString("state") != "cancelled") { "This transfer was cancelled. Ask the sender for a new link." }
        }
        val task = previous?.let { JSONObject(it.toString()) } ?: JSONObject().put("id", invitation?.id ?: "code-${UUID.randomUUID()}").put("url", url)
        if (code != null) task.put("code", code)
        task.put("resumable", invitation?.version == 2)
        if (task.optString("state") != "receiving") task.put("state", "queued")
        task.remove("error")
        return task
    }
    fun resolveCapability(body: JSONObject): String {
        require(code != null)
        val origin = body.optString("origin", "https://cd.yash0.in")
        require(origin in listOf("https://cd.yash0.in", "https://cdx.yash0.in")) { "Invalid transfer origin" }
        val resolved = "$origin/s/${body.getString("transferId")}#v1.${body.getString("key")}"
        Invitation.parse(resolved)
        return resolved
    }
    companion object {
        fun parse(raw: String): DownloadRequest {
            val url = raw.trim()
            if (url.matches(Regex("[0-9]{4,5}"))) return DownloadRequest(url, null, url)
            val uri = URI(url)
            if (uri.scheme in listOf("http", "https") && uri.host == "cd.yash0.in" && uri.userInfo == null && uri.port == -1 && uri.query == null && uri.path in listOf("", "/") && uri.rawFragment?.matches(Regex("[0-9]{4,5}")) == true) {
                return DownloadRequest(url, null, uri.rawFragment)
            }
            // shortcut: browser word-code transfers require the web receiver until native tunnel support is added.
            val invitation = runCatching { Invitation.parse(url) }.getOrElse {
                throw IllegalArgumentException("This is not a file download link. Use a CD short code or a private v1 or v2 transfer link.")
            }
            return DownloadRequest(url, invitation)
        }
    }
}
