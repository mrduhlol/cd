package `in`.yash0.cd

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

object PushTarget {
    fun request(relay: String, pairId: String, receiverToken: String, fid: String?): Request {
        require(fid == null || fid.matches(Regex("[A-Za-z0-9_-]{22}")))
        val body = JSONObject().put("v", 1).put("token", receiverToken).apply { if (fid != null) put("fid", fid) }.toString().toRequestBody("application/json".toMediaType())
        return Request.Builder().url(PushPolicy.targetUrl(relay, pairId)).method(if (fid == null) "DELETE" else "POST", body).build()
    }
}
