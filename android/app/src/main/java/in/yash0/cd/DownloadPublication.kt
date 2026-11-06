package `in`.yash0.cd

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

internal fun publishDownload(context: Context, store: Store, task: JSONObject, stage: File, filename: String, size: Long, active: () -> Unit) {
    val resolver = context.contentResolver
    val existing = task.optString("publishedUri")
    var uri = existing.takeIf { it.isNotEmpty() }?.let(Uri::parse)
    if (uri == null) {
        uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, filename); put(MediaStore.MediaColumns.MIME_TYPE, fileMime(filename) { android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }); put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/CD"); put(MediaStore.MediaColumns.IS_PENDING, 1)
        }) ?: error("Could not create Downloads file")
        try { store.publication(task.getString("id"), uri.toString(), task.getString("wholeSha256")); task.put("publishedUri", uri.toString()) } catch (e: Exception) { resolver.delete(uri, null, null); throw e }
    }
    val alreadyPublished = resolver.query(uri, arrayOf(MediaStore.MediaColumns.IS_PENDING), null, null, null)?.use { cursor -> cursor.moveToFirst() && cursor.getInt(0) == 0 } ?: false
    if (!alreadyPublished) resolver.openFileDescriptor(uri, "rwt")!!.use { pfd -> java.io.FileOutputStream(pfd.fileDescriptor).use { out -> FileInputStream(stage).use { input ->
        val buffer = ByteArray(262144)
        while (true) { active(); val n = input.read(buffer); if (n < 0) break; out.write(buffer, 0, n) }
    }; out.fd.sync() } }
    else {
        val actual = MessageDigest.getInstance("SHA-256")
        var count = 0L
        resolver.openInputStream(uri)!!.use { input -> val b = ByteArray(262144); while (true) { active(); val n = input.read(b); if (n < 0) break; actual.update(b, 0, n); count += n } }
        require(count == size && Crypto.hex(actual.digest()) == task.getString("wholeSha256")) { "Published file changed before completion recovery" }
    }
    active()
    check(stage.length() == size)
    check(resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null) == 1)
    store.completed(task.getString("id"), uri.toString(), filename, size); task.put("state", "complete")
}
