package `in`.yash0.cd

import android.content.Context
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

object TransferFiles {
    private val active = ConcurrentHashMap<String, String>()
    fun start(task: JSONObject): Boolean = active.putIfAbsent(Invitation.parse(task.getString("url")).id, task.getString("id")) == null
    fun finish(task: JSONObject) { active.remove(Invitation.parse(task.getString("url")).id, task.getString("id")) }
    fun staging(context: Context, task: JSONObject) {
        val invite = Invitation.parse(task.getString("url"))
        File(context.filesDir, "resume-${invite.id}.part").delete()
        AtomicFile(File(context.filesDir, "resume-${invite.id}.json")).delete()
    }
    fun discard(context: Context, store: Store, id: String, receiverFinished: Boolean = false) {
        val task = store.task(id) ?: return
        if (!receiverFinished && active.containsKey(Invitation.parse(task.getString("url")).id)) return
        if (task.getString("state") != "cancelled") return
        runCatching {
            staging(context, task)
            task.optString("publishedUri").takeIf { it.isNotEmpty() }?.let { context.contentResolver.delete(Uri.parse(it), null, null) }
            store.putTask(task.put("discarded", true))
        }
    }
}
