package `in`.yash0.cd

import android.net.Uri
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.Assert.*
import java.io.File
import java.security.MessageDigest

/** Run with -e publicBase http://10.0.2.2:PORT; receive the reported code externally. */
class NativeSenderInteropTest {
    @Test fun testNativeSend() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val base = InstrumentationRegistry.getArguments().getString("publicBase") ?: error("publicBase required")
        val engine = SendEngineImpl(context, base)
        val files = (0..1).map { index ->
            File(context.cacheDir, "interop-$index.bin").apply {
                outputStream().use { out ->
                    val block = ByteArray(65536) { ((it * 31 + index) % 251).toByte() }
                    repeat(40) { out.write(block) }
                    out.write(byteArrayOf(1, 2, 3, index.toByte()))
                }
            }
        }
        val id = engine.start(context, files.map(Uri::fromFile))
        try {
            val deadline = System.currentTimeMillis() + 180000
            var announced = false
            while (System.currentTimeMillis() < deadline) {
                val view = TransferBus.transfers.value.firstOrNull { it.id == id }
                if (view?.code != null && !announced) {
                    val source = SenderStore(context).source(id)
                    assertTrue(source.length() > SendProtocol.WINDOW)
                    assertTrue(source.length() % SendProtocol.CHUNK != 0L)
                    val digest = MessageDigest.getInstance("SHA-256")
                    source.inputStream().use { input -> val bytes = ByteArray(65536); while (true) { val n = input.read(bytes); if (n < 0) break; digest.update(bytes, 0, n) } }
                    instrumentation.sendStatus(0, Bundle().apply { putString("stream", "NATIVE_SEND code=${view.code} size=${source.length()} sha256=${Crypto.hex(digest.digest())}\n") })
                    announced = true
                }
                if (view?.phase == TransferPhase.COMPLETE) { assertTrue(announced); return }
                assertFalse("Sender paused: ${view?.message}", view?.phase == TransferPhase.PAUSED)
                Thread.sleep(100)
            }
            fail("Receiver did not complete within 180 seconds")
        } finally {
            if (TransferBus.transfers.value.firstOrNull { it.id == id }?.phase != TransferPhase.COMPLETE) engine.cancel(context, id)
            files.forEach { it.delete() }
        }
    }
}
