package `in`.yash0.cd

import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File

internal class SenderStore(context: Context) {
    val directory = File(context.filesDir, "send-v2").apply { mkdirs() }
    fun source(id: String): File = File(directory, "$id.payload")
    private fun metadata(id: String): AtomicFile {
        require(id.matches(Regex("[A-Za-z0-9_-]{22}")))
        return AtomicFile(File(directory, "$id.json"))
    }
    @Synchronized fun save(j: JSONObject) {
        val file = metadata(j.getString("id"))
        val output = file.startWrite()
        try { output.write(j.toString().toByteArray()); file.finishWrite(output) }
        catch (e: Exception) { file.failWrite(output); throw e }
    }
    @Synchronized fun load(id: String): JSONObject = metadata(id).openRead().bufferedReader().use { JSONObject(it.readText()) }
    fun all(): List<JSONObject> = directory.listFiles().orEmpty().filter { it.extension == "json" }.mapNotNull { runCatching { load(it.nameWithoutExtension) }.getOrNull() }
}
