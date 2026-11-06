package `in`.yash0.cd

import org.json.JSONObject

internal data class OrdinaryOffer(val name: String, val size: Long, val chunkSize: Int) {
    fun checkChunk(written: Long, length: Int) {
        require(length in 1..chunkSize && written + length <= size && (length == chunkSize || written + length == size)) { "Invalid chunk bounds" }
    }
    companion object {
        fun parse(json: JSONObject): OrdinaryOffer {
            val name = json.getString("name")
            require(name.toByteArray().size in 1..255 && name !in listOf(".", "..") && name.none { it == '/' || it == '\\' || it.code < 32 }) { "Unsafe filename" }
            val size = json.getString("size")
            require(size.matches(Regex("0|[1-9][0-9]*")) && size.toLong() in 0..9007199254740991L) { "Invalid file size" }
            val chunkSize = json.getInt("chunkSize")
            require(chunkSize in listOf(65536, 262144, 786432)) { "Unsupported chunk size" }
            return OrdinaryOffer(name, size.toLong(), chunkSize)
        }
    }
}
