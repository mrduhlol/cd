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

class Store(context: Context) {
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
    @Synchronized fun putTask(task: JSONObject) { root.getJSONObject("tasks").put(task.getString("id"), task); save(); ReceiveViews.publish(task) }
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
        val now = System.currentTimeMillis()
        val replay = root.getJSONObject("replays")
        replay.keys().asSequence().toList().forEach { if (replay.getLong(it) <= now) replay.remove(it) }
        val messageId = msg.getString("messageId")
        val id = msg.getString("transferId")
        val existing = task(id)
        OfferValidation.validate(msg, existing)
        require(existing == null || existing.optString("pairId").isEmpty() || existing.optString("pairId") == pair.id) { "Transfer belongs to another trusted device" }
        val replayed = replay.has(messageId)
        if (existing != null) {
            replay.put(messageId, msg.getLong("expiresAt"))
            if (preferLocal && msg.optString("localUrl").isNotEmpty()) {
                existing.put("localUrl", msg.getString("localUrl")); root.getJSONObject("tasks").put(id, existing)
            }
            save(); return false
        }
        if (replayed) { save(); return false }
        require(tasks().count { it.getString("state") !in listOf("complete", "paused", "cancelled") } < 16) { "Receive queue full" }
        replay.put(messageId, msg.getLong("expiresAt"))
        root.getJSONObject("tasks").put(id, JSONObject(msg.toString()).put("id", id).put("pairId", pair.id).put("state", "queued"))
        save(); task(id)?.let { ReceiveViews.publish(it) }; return true
    }
}
