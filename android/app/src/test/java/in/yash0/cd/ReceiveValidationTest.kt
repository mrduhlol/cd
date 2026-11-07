package `in`.yash0.cd

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReceiveValidationTest {
    private fun offer(): JSONObject = JSONObject(javaClass.classLoader!!.getResource("device-v1.json")!!.readText()).getJSONObject("offer")
    @Test fun offerBindsTransferIdAndEveryImmutableField() {
        val original = offer()
        assertEquals(original.getString("transferId"), OfferValidation.validate(original).id)
        val otherId = JSONObject(original.toString()).put("transferId", Crypto.encode(ByteArray(16) { 99 }))
        assertThrows(IllegalArgumentException::class.java) { OfferValidation.validate(otherId) }
        val existing = JSONObject(original.toString())
        mapOf("filename" to "another.bin", "size" to "4", "wholeSha256" to "0".repeat(64), "url" to original.getString("url").replace("cd.yash0.in", "example.com")).forEach { (field, value) ->
            assertThrows("changed $field", IllegalArgumentException::class.java) { OfferValidation.validate(JSONObject(original.toString()).put(field, value), existing) }
        }
        assertThrows(IllegalArgumentException::class.java) { OfferValidation.validate(JSONObject(original.toString()).put("filename", "../escape")) }
        assertThrows(IllegalArgumentException::class.java) { OfferValidation.validate(JSONObject(original.toString()).put("size", "03")) }
        assertThrows(IllegalArgumentException::class.java) { OfferValidation.validate(JSONObject(original.toString()).put("localUrl", "ws://192.168.1.2/ws/v2/wrong")) }
    }
    @Test fun durableAckBoundariesKeepLegacyCompatibilityAndCommitFinalPartialBatch() {
        fun acknowledgements(window: Long): List<Long> {
            val policy = DurableAckPolicy(window)
            val chunks = listOf(262144L, 262144L, 262144L, 262144L, 262144L, 123L)
            val size = chunks.sum()
            var written = 0L
            var committed = 0L
            val acknowledgements = mutableListOf<Long>()
            chunks.forEach { chunk ->
                written += chunk
                if (policy.commit(written, committed, size)) { committed = written; acknowledgements.add(committed) }
            }
            return acknowledgements
        }
        assertEquals(listOf(262144L, 524288L, 786432L, 1048576L, 1310720L, 1310843L), acknowledgements(0))
        assertEquals(listOf(262144L, 524288L, 786432L, 1048576L, 1310720L, 1310843L), acknowledgements(1048575))
        assertEquals(listOf(1310843L), acknowledgements(4194304))
        assertEquals(listOf(1048576L, 1310843L), acknowledgements(1048576))
    }
    @Test fun storageBudgetReservesRetainedRemainderAndDownloadsCopyOnSameVolume() {
        assertEquals(StorageBudget.Required(160, 0), StorageBudget.required(size = 100, offset = 40, sameVolume = true))
        assertEquals(StorageBudget.Required(60, 100), StorageBudget.required(size = 100, offset = 40, sameVolume = false))
        assertEquals(StorageBudget.Required(100, 0), StorageBudget.required(size = 100, offset = 100, sameVolume = true))
        assertEquals(StorageBudget.Required(0, 0), StorageBudget.required(size = 100, offset = 100, sameVolume = true, alreadyPublished = true))
        assertEquals(StorageBudget.Required(0, 0), StorageBudget.required(size = 0, offset = 0, sameVolume = true))
        assertThrows(IllegalArgumentException::class.java) { StorageBudget.required(size = 100, offset = 101, sameVolume = true) }
    }
}
