package com.yashasvm.cd.sample

import androidx.activity.ComponentActivity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import com.yashasvm.cd.sdk.CdFileSource
import com.yashasvm.cd.sdk.CdTransferClient
import com.yashasvm.cd.sdk.CdTransferProgress
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import kotlin.coroutines.resume

/** Minimal example: the app owns selection, consent, destination and its UI. */
class SampleActivity : ComponentActivity() {
    private val scope = MainScope()
    private lateinit var client: CdTransferClient
    private lateinit var invitation: EditText
    private lateinit var status: TextView
    private lateinit var progress: TextView

    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch { send(uri) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        client = CdTransferClient(applicationId = packageName)
        invitation = EditText(this).apply {
            hint = "Paste a CD invitation"
            minLines = 3
            maxLines = 5
            setTextIsSelectable(true)
        }
        status = TextView(this).apply { text = "Ready. The invitation is shared out of band." }
        progress = TextView(this)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 28, 24, 24)
            addView(TextView(this@SampleActivity).apply {
                text = "CD transfer SDK sample"
                textSize = 24f
            })
            addView(TextView(this@SampleActivity).apply {
                text = "Both people run an app using the SDK. The sender stays online until the recipient accepts and the transfer verifies."
                setPadding(0, 16, 0, 16)
            })
            addView(Button(this@SampleActivity).apply {
                text = "Pick file and send"
                setOnClickListener { pickFile.launch(arrayOf("*/*")) }
            })
            addView(invitation, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(Button(this@SampleActivity).apply {
                text = "Accept invitation and receive"
                setOnClickListener { scope.launch { receive(invitation.text.toString().trim()) } }
            })
            addView(status)
            addView(progress)
            addView(TextView(this@SampleActivity).apply {
                text = "Received sample files are written to this app's cache directory. A real app should choose its own private or user-visible destination."
                setPadding(0, 18, 0, 0)
            })
        }
        setContentView(ScrollView(this).apply { addView(content) })
    }

    private suspend fun send(uri: Uri) {
        try {
            contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Some providers grant a temporary read permission only.
        }
        try {
            val source = describe(uri)
            status.text = "Connecting to CD…"
            client.send(source, onInvitation = { link -> runOnUiThread { invitation.setText(link) } }, onProgress = ::showProgress)
            status.text = "Recipient verified the complete file."
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            status.text = "Send failed: ${failure.message ?: "unknown error"}"
        }
    }

    private fun describe(uri: Uri): CdFileSource {
        var name = "shared-file"
        var size = -1L
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = cursor.getString(it) ?: name }
                cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { size = cursor.getLong(it) }
            }
        }
        require(size >= 0) { "The selected provider did not report a file size" }
        val type = contentResolver.getType(uri) ?: "application/octet-stream"
        return CdFileSource(name, type, size) {
            contentResolver.openInputStream(uri) ?: error("Cannot open selected file")
        }
    }

    private suspend fun receive(link: String) {
        if (link.isBlank()) { status.text = "Paste the invitation first."; return }
        try {
            status.text = "Connecting to sender…"
            client.receive(
                invitation = link,
                acceptOffer = { offer ->
                    suspendCancellableCoroutine { continuation ->
                        runOnUiThread {
                            AlertDialog.Builder(this)
                                .setTitle("Receive ${offer.name}?")
                                .setMessage("${offer.sizeBytes} bytes will be saved in this app's cache.")
                                .setPositiveButton("Accept") { _, _ -> if (continuation.isActive) continuation.resume(true) }
                                .setNegativeButton("Reject") { _, _ -> if (continuation.isActive) continuation.resume(false) }
                                .setOnCancelListener { if (continuation.isActive) continuation.resume(false) }
                                .show()
                        }
                    }
                },
                openDestination = { offer -> File(cacheDir, offer.name).outputStream() },
                onProgress = ::showProgress,
            )
            status.text = "File verified and saved in ${cacheDir.absolutePath}."
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            status.text = "Receive failed: ${failure.message ?: "unknown error"}"
        }
    }

    private fun showProgress(value: CdTransferProgress) {
        runOnUiThread { progress.text = "${value.phase}: ${value.transferredBytes} / ${value.totalBytes} bytes" }
    }

    override fun onDestroy() {
        client.close()
        scope.cancel()
        super.onDestroy()
    }
}
