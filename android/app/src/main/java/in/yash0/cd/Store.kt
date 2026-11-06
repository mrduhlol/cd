package `in`.yash0.cd

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal fun receiveQueueHasRoom(tasks: List<JSONObject>): Boolean =
    tasks.count { it.optString("state") in listOf("queued", "connecting", "receiving", "verifying", "retrying") } < 16

internal fun receiveCanResume(task: JSONObject): Boolean = task.optBoolean("resumable", runCatching { Invitation.parse(task.getString("url")).version == 2 }.getOrDefault(true))

internal fun canDismissReceive(state: String): Boolean = state in listOf("complete", "failed", "cancelled")

internal fun recoverReceiveTask(task: JSONObject): JSONObject? {
    if (task.optString("state") !in listOf("connecting", "receiving", "verifying", "retrying")) return null
    val recovered = JSONObject(task.toString())
    if (receiveCanResume(task)) recovered.put("state", "queued").remove("error")
    else recovered.put("state", "failed").put("error", "Transfer interrupted. Ask the sender for a new link or code.")
    return recovered
}

internal fun dismissReceiveTask(root: JSONObject, id: String, now: Long): Boolean {
    val task = root.getJSONObject("tasks").optJSONObject(id) ?: return true
    if (!canDismissReceive(task.optString("state"))) return false
    task.put("dismissedUntil", now + 24 * 60 * 60 * 1000L)
    return true
}

internal fun addReceiveOffer(root: JSONObject, pairId: String, msg: JSONObject, preferLocal: Boolean = false, now: Long = System.currentTimeMillis()): Boolean {
    val tasks = root.getJSONObject("tasks")
    tasks.keys().asSequence().toList().forEach { id ->
        val until = tasks.getJSONObject(id).optLong("dismissedUntil")
        if (until > 0 && until <= now) tasks.remove(id)
    }
    val replay = root.getJSONObject("replays")
    replay.keys().asSequence().toList().forEach { if (replay.getLong(it) <= now) replay.remove(it) }
    val messageId = msg.getString("messageId")
    val id = msg.getString("transferId")
    val existing = tasks.optJSONObject(id)?.let { JSONObject(it.toString()) }
    OfferValidation.validate(msg, existing)
    require(existing == null || existing.optString("pairId").isEmpty() || existing.optString("pairId") == pairId) { "Transfer belongs to another trusted device" }
    val replayed = replay.has(messageId)
    if (existing != null) {
        replay.put(messageId, msg.getLong("expiresAt"))
        if (preferLocal && msg.optString("localUrl").isNotEmpty()) {
            existing.put("localUrl", msg.getString("localUrl")); tasks.put(id, existing)
        }
        return false
    }
    if (replayed) return false
    require(receiveQueueHasRoom(tasks.keys().asSequence().map { tasks.getJSONObject(it) }.toList())) { "Receive queue full" }
    replay.put(messageId, msg.getLong("expiresAt"))
    tasks.put(id, JSONObject(msg.toString()).apply { remove("dismissedUntil") }.put("id", id).put("pairId", pairId).put("state", "queued"))
    return true
}

class Store(context: Context) {
    private val appContext = context.applicationContext
    private val vault = AtomicFile(File(context.filesDir, "devices-v1.vault"))
    private val key: SecretKey
    private var root: JSONObject
    init {
        runCatching { StorageBudget.reserve(context) }
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        key = (keys.getKey("cd-vault-v1", null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder("cd-vault-v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); generateKey()
        }
        root = if (!vault.baseFile.exists()) JSONObject().put("pairs", JSONObject()).put("tasks", JSONObject()).put("replays", JSONObject()) else {
            val b = vault.readFully()
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, b.copyOfRange(0, 12)))
            JSONObject(String(c.doFinal(b.copyOfRange(12, b.size))))
        }
    }
    @Synchronized private fun save() {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        val bytes = c.iv + c.doFinal(root.toString().toByteArray())
        val output = vault.startWrite()
        try { output.write(bytes); vault.finishWrite(output); DurableFiles.directory(vault.baseFile.parentFile!!) } catch (e: Exception) { vault.failWrite(output); throw e }
    }
    @Synchronized fun pairs(): List<Pairing> = root.getJSONObject("pairs").let { p -> p.keys().asSequence().map { Pairing(JSONObject(p.getJSONObject(it).toString())) }.toList() }
    @Synchronized fun trust(pair: Pairing) { root.getJSONObject("pairs").put(pair.id, pair.json); save() }
    @Synchronized fun revoke(id: String) { val denied = root.optJSONObject("accountDenied") ?: JSONObject().also { root.put("accountDenied", it) }; denied.put(id, true); root.getJSONObject("pairs").remove(id); root.optJSONObject("pushWakes")?.remove(id); tasks().filter { it.optString("pairId") == id && it.optString("state") != "complete" }.forEach { it.put("state", "paused"); root.getJSONObject("tasks").put(it.getString("id"), it) }; save() }
    @Synchronized fun allowedMobile(): Boolean = root.optBoolean("mobile")
    @Synchronized fun pauseReceiving(): List<JSONObject> {
        root.put("enabled", false)
        val paused = tasks().filter { it.getString("state") in listOf("queued", "connecting", "receiving", "verifying", "retrying") }
        paused.forEach { task -> root.getJSONObject("tasks").put(task.getString("id"), task.put("state", "paused")) }
        save(); paused.forEach { ReceiveViews.publish(it) }; return paused
    }
    @Synchronized fun pushEnabled(): Boolean = root.optBoolean("pushEnabled")
    @Synchronized fun pushEnabled(value: Boolean) { root.put("pushEnabled", value); save() }
    @Synchronized fun acceptPushWake(id: String, issuedAt: Long, now: Long): Boolean {
        if (!pushEnabled() || !enabled() || !root.getJSONObject("pairs").has(id)) return false
        val wakes = root.optJSONObject("pushWakes") ?: JSONObject().also { root.put("pushWakes", it) }
        val previous = wakes.optJSONObject(id)
        if (!PushPolicy.acceptWake(previous?.optLong("issuedAt") ?: 0, previous?.optLong("receivedAt") ?: 0, issuedAt, now)) return false
        wakes.put(id, JSONObject().put("issuedAt", issuedAt).put("receivedAt", now)); save(); return true
    }
    @Synchronized fun pushFid(): String = root.optString("pushFid")
    @Synchronized fun pushFid(value: String) { root.put("pushFid", value); save() }
    @Synchronized fun pushDeletes(): List<JSONObject> = root.optJSONObject("pushDeletes")?.let { p -> p.keys().asSequence().map { JSONObject(p.getJSONObject(it).toString()) }.toList() } ?: emptyList()
    @Synchronized fun queuePushDelete(pair: Pairing) {
        val pending = root.optJSONObject("pushDeletes") ?: JSONObject().also { root.put("pushDeletes", it) }
        pending.put(pair.id, JSONObject().put("id", pair.id).put("relayUrl", pair.json.getString("relayUrl")).put("token", pair.token()))
        save()
    }
    @Synchronized fun finishPushDelete(id: String) { root.optJSONObject("pushDeletes")?.remove(id); save() }
    @Synchronized fun mobile(value: Boolean) { root.put("mobile", value); save() }
    @Synchronized fun enabled(): Boolean = root.optBoolean("enabled")
    @Synchronized fun enabled(value: Boolean) { root.put("enabled", value); save() }
    @Synchronized fun tasks(): List<JSONObject> = root.getJSONObject("tasks").let { p -> p.keys().asSequence().map { JSONObject(p.getJSONObject(it).toString()) }.toList() }
    @Synchronized fun task(id: String): JSONObject? = root.getJSONObject("tasks").optJSONObject(id)?.let { JSONObject(it.toString()) }
    @Synchronized fun recoverInterruptedTransfers() {
        tasks().mapNotNull(::recoverReceiveTask).forEach(::putTask)
    }
    @Synchronized fun putTask(task: JSONObject) { root.getJSONObject("tasks").put(task.getString("id"), JSONObject(task.toString())); save(); ReceiveViews.publish(task) }
    @Synchronized fun dismiss(id: String): Boolean {
        val task = task(id) ?: return true
        if (!canDismissReceive(task.optString("state"))) return false
        if (task.optString("state") != "complete") {
            TransferFiles.staging(appContext, task)
            task.optString("publishedUri").takeIf { it.isNotEmpty() }?.let { saved ->
                val uri = android.net.Uri.parse(saved)
                val pending = appContext.contentResolver.query(uri, arrayOf(android.provider.MediaStore.MediaColumns.IS_PENDING), null, null, null)?.use {
                    it.moveToFirst() && it.getInt(0) == 1
                } ?: false
                if (pending) appContext.contentResolver.delete(uri, null, null)
            }
        }
        dismissReceiveTask(root, id, System.currentTimeMillis())
        save()
        return true
    }

    @Synchronized fun taskState(id: String): String? = root.getJSONObject("tasks").optJSONObject(id)?.optString("state")
    /** Progress is a view of the durable checkpoint, not another fsync on every tick. */
    @Synchronized fun progress(id: String, received: Long? = null, route: String? = null) {
        val task = root.getJSONObject("tasks").optJSONObject(id) ?: return
        received?.let { task.put("received", it) }
        route?.let { task.put("route", it) }
        ReceiveViews.publish(task)
    }
    @Synchronized fun state(id: String, next: String, error: String? = null): JSONObject? {
        val task = task(id) ?: return null
        val current = task.getString("state")
        if (current in listOf("complete", "cancelled")) return null
        if (next in listOf("connecting", "receiving", "verifying") && current !in listOf("queued", "connecting", "receiving", "verifying", "retrying")) return null
        if (next == "retrying" && current == "paused") return null
        if (next == "cancelled" && current != "paused") return null
        task.put("state", next)
        if (error != null) task.put("error", error) else task.remove("error")
        putTask(task); return task
    }
    @Synchronized fun publication(id: String, uri: String, digest: String): JSONObject {
        val task = task(id) ?: error("Unknown transfer")
        check(task.getString("state") !in listOf("paused", "cancelled")) { "Paused" }
        task.put("publishedUri", uri).put("wholeSha256", digest); putTask(task); return task
    }
    @Synchronized fun completed(id: String, uri: String, filename: String, size: Long) {
        val task = task(id) ?: error("Unknown transfer")
        check(task.getString("state") != "cancelled") { "Cancelled" }
        putTask(task.put("publishedUri", uri).put("state", "complete").put("filename", filename).put("received", size))
    }
    @Synchronized fun offered(id: String, filename: String, size: Long, digest: String, expiresAt: Long) {
        val task = task(id) ?: error("Unknown transfer")
        require(!task.has("filename") || task.getString("filename") == filename) { "Filename changed" }
        require(!task.has("size") || task.getString("size").toLong() == size) { "File size changed" }
        require(!task.has("wholeSha256") || task.getString("wholeSha256") == digest) { "File digest changed" }
        putTask(task.put("filename", filename).put("size", size.toString()).put("wholeSha256", digest).put("rootExpiresAt", expiresAt))
    }
    @Synchronized fun addOffer(pair: Pairing, msg: JSONObject, preferLocal: Boolean = false): Boolean {
        val added = addReceiveOffer(root, pair.id, msg, preferLocal)
        save()
        if (added) task(msg.getString("transferId"))?.let { ReceiveViews.publish(it) }
        return added
    }

}
