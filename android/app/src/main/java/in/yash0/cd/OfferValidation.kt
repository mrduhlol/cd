package `in`.yash0.cd

import org.json.JSONObject
import java.net.URI

object OfferValidation {
    fun validate(message: JSONObject, existing: JSONObject? = null): Invitation {
        val id = message.getString("transferId")
        Crypto.decode(id, 16)
        val invitation = Invitation.parse(message.getString("url"))
        require(id == invitation.id) { "Transfer identity differs from its invitation" }
        val filename = message.getString("filename")
        require(filename.toByteArray().size in 1..255 && filename !in listOf(".", "..") && filename.none { it == '/' || it == '\\' || it.code < 32 }) { "Unsafe offered filename" }
        val size = message.getString("size")
        require(size.matches(Regex("0|[1-9][0-9]*")) && size.toLong() in 0..9007199254740991L) { "Invalid offered size" }
        require(message.getString("wholeSha256").matches(Regex("[0-9a-f]{64}"))) { "Invalid offered digest" }
        val local = message.optString("localUrl")
        require(local.isEmpty() || (localEndpoint(local) && URI(local).path == "/ws/v2/$id")) { "Invalid local transfer endpoint" }
        existing?.let { old ->
            require(old.getString("url") == message.getString("url")) { "Invitation changed for an existing transfer" }
            listOf("filename", "size", "wholeSha256").forEach { field ->
                require(!old.has(field) || old.get(field).toString() == message.get(field).toString()) { "Offered $field changed for an existing transfer" }
            }
        }
        return invitation
    }
}
