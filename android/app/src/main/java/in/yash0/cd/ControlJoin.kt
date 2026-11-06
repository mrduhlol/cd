package `in`.yash0.cd

import org.json.JSONObject

class ControlJoin(private val pair: Pairing, private val localTransport: Boolean) {
    private var challengeAnswered = false
    @Volatile var admitted = false
        private set
    fun initial(): JSONObject? = if (localTransport) null else base().put("token", pair.token())
    fun event(event: JSONObject): JSONObject? {
        require(event.getString("protocol") == "cd-device-v1")
        when (event.getString("type")) {
            "challenge" -> {
                require(localTransport && !challengeAnswered && !admitted) { "Unexpected local challenge" }
                val nonce = event.getString("nonce")
                Crypto.decode(nonce, 32)
                challengeAnswered = true
                return base().put("localProof", pair.localProof(nonce))
            }
            "accepted" -> { require(!localTransport || challengeAnswered) { "Local challenge required" }; admitted = true }
            "peer-joined", "peer-left", "pong" -> require(admitted) { "Control event before admission" }
            else -> error("Unexpected control event")
        }
        return null
    }
    private fun base(): JSONObject = JSONObject().put("type", "join").put("protocol", "cd-device-v1").put("role", "receiver")
}
