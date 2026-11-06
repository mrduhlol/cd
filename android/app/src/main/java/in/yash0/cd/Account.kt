package `in`.yash0.cd

import android.content.Context
import android.content.Intent
import android.net.Uri
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec

object Account {
    private const val issuer = "https://electric-arachnid-4684.clerk.accounts.dev"
    private const val clientId = "A5eL6DW58r6rKyit"
    private const val api = "https://cd-test.yash0.in/api/account/v1"
    private val client = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).followRedirects(false).build()
    @Volatile var status = "Sign in to receive from your own terminals without transfer codes."
    @Volatile var signingIn = false
    private var nextPoll = 0L
    private fun form(endpoint: String, fields: Map<String, String>): JSONObject {
        val body = FormBody.Builder().apply { fields.forEach { (k,v) -> add(k,v) } }.build()
        client.newCall(Request.Builder().url(endpoint).post(body).build()).execute().use { response ->
            require(response.code < 500) { "Clerk temporarily unavailable" }
            return JSONObject(response.body!!.string())
        }
    }
    fun login(context: Context) {
        if (signingIn) return
        signingIn = true
        Thread {
            try {
                val start = form("$issuer/oauth/device_authorization", mapOf("client_id" to clientId, "scope" to "openid profile email offline_access"))
                val uri = start.getString("verification_uri_complete")
                require(Uri.parse(uri).scheme == "https")
                status = "Confirm ${start.getString("user_code")} in your browser."
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                val expiry = android.os.SystemClock.elapsedRealtime() + start.getLong("expires_in") * 1000
                var interval = start.getLong("interval").coerceAtLeast(1) * 1000
                while (android.os.SystemClock.elapsedRealtime() < expiry) {
                    Thread.sleep(interval)
                    val tokens = form("$issuer/oauth/token", mapOf("client_id" to clientId, "grant_type" to "urn:ietf:params:oauth:grant-type:device_code", "device_code" to start.getString("device_code")))
                    when (tokens.optString("error")) {
                        "authorization_pending" -> continue
                        "slow_down" -> { interval += 5000; continue }
                        "" -> {
                            require(tokens.getString("refresh_token").isNotBlank())
                            tokens.put("expires_at", System.currentTimeMillis() + tokens.getLong("expires_in") * 1000)
                            tokens.put("device_id", Crypto.encode(Crypto.random(16)))
                            val encryption = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
                            tokens.put("pair_private", Crypto.encode(encryption.private.encoded)).put("pair_public", Crypto.encode(encryption.public.encoded))
                            StoreRegistry.get(context).account(tokens)
                            register(context)
                            status = "Signed in. Account receiving enabled as phone."
                            return@Thread
                        }
                        else -> error("Sign-in failed: ${tokens.optString("error")}")
                    }
                }
                error("Sign-in expired. Try again.")
            } catch (e: Exception) { status = e.message ?: "Could not sign in" }
            finally { signingIn = false }
        }.start()
    }
    @Synchronized private fun access(context: Context): String {
        val store = StoreRegistry.get(context)
        val tokens = store.account() ?: error("Sign in required")
        if (tokens.getLong("expires_at") > System.currentTimeMillis() + 60000) return tokens.getString("access_token")
        val refreshed = form("$issuer/oauth/token", mapOf("client_id" to clientId, "grant_type" to "refresh_token", "refresh_token" to tokens.getString("refresh_token")))
        require(refreshed.optString("access_token").isNotBlank()) { "Sign in again to reconnect account receiving" }
        if (refreshed.optString("refresh_token").isBlank()) refreshed.put("refresh_token", tokens.getString("refresh_token"))
        refreshed.put("pair_private", tokens.getString("pair_private")).put("pair_public", tokens.getString("pair_public")).put("device_id", tokens.getString("device_id")).put("expires_at", System.currentTimeMillis() + refreshed.getLong("expires_in") * 1000)
        store.account(refreshed)
        return refreshed.getString("access_token")
    }
    private fun request(context: Context, method: String, path: String, data: JSONObject? = null): JSONObject {
        val builder = Request.Builder().url(api + path).header("Authorization", "Bearer ${access(context)}")
        if (method != "GET") builder.method(method, (data ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            require(response.isSuccessful) { "Account service returned ${response.code}" }
            return JSONObject(response.body!!.string())
        }
    }
    private fun register(context: Context) {
        val tokens = StoreRegistry.get(context).account() ?: return
        request(context, "POST", "/phone", JSONObject().put("id", tokens.getString("device_id")).put("name", "phone").put("publicKey", tokens.getString("pair_public")))
    }
    fun maintenance(context: Context) {
        val store = StoreRegistry.get(context)
        val tokens = store.account() ?: return
        if (System.currentTimeMillis() < nextPoll) return
        nextPoll = System.currentTimeMillis() + 10000
        try {
            val directory = request(context, "GET", "")
            val phones = directory.getJSONArray("phones")
            if (!(0 until phones.length()).any { phones.getJSONObject(it).getString("id") == tokens.getString("device_id") }) {
                store.pairs().filter { it.json.has("accountDevice") }.forEach { store.revoke(it.id) }
                store.account(null)
                status = "Account receiving revoked. Sign in again."
                return
            }
            val pairs = directory.getJSONArray("pairs")
            repeat(pairs.length()) {
                val pending = pairs.getJSONObject(it)
                if (pending.getString("target") == tokens.getString("device_id") && !store.accountDenied(pending.getString("id"))) {
                    val link = openAccountPair(pending.getString("envelope"), tokens.getString("pair_private"), pending.getString("id"), tokens.getString("device_id"))
                    val pair = Pairing.parse(link)
                    require(pair.id == pending.getString("id"))
                    if (store.pairs().none { p -> p.id == pair.id }) store.trust(Pairing(pair.json.put("accountDevice", tokens.getString("device_id"))))
                }
            }
            status = "Account receiving enabled as phone"
        } catch (e: Exception) { status = e.message ?: "Waiting for account connection" }
    }
    fun logout(context: Context) {
        Thread {
            val store = StoreRegistry.get(context)
            val tokens = store.account()
            store.pairs().filter { it.json.has("accountDevice") }.forEach { store.revoke(it.id) }
            store.account(null)
            try {
                if (tokens != null) {
                    val body = JSONObject().put("id", tokens.getString("device_id")).toString().toRequestBody("application/json".toMediaType())
                    val request = Request.Builder().url("$api/phone").header("Authorization", "Bearer ${tokens.getString("access_token")}").delete(body).build()
                    client.newCall(request).execute().close()
                }
            } catch (_: Exception) { }
            status = "Signed out. Account devices no longer trusted."
        }.start()
    }
}
