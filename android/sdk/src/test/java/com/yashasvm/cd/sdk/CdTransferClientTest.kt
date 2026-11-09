package com.yashasvm.cd.sdk

import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Test
import java.io.ByteArrayOutputStream

class CdTransferClientTest {
    @Test fun transfersEmptyAndMultiWindowFiles() = runBlocking {
        for (size in listOf(0, 5 * 1024 * 1024 + 17)) {
            MockWebServer().use { server ->
                val peers = mutableMapOf<String, WebSocket>()
                repeat(2) {
                    server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                        private lateinit var role: String
                        override fun onClosing(socket: WebSocket, code: Int, reason: String) { socket.close(code, reason) }
                        override fun onMessage(socket: WebSocket, text: String) {
                            role = JSONObject(text).getString("role")
                            synchronized(peers) {
                                peers[role] = socket
                                socket.send("""{"protocol":"cd-transfer-v1","type":"accepted"}""")
                                if (peers.size == 2) peers.values.forEach {
                                    it.send("""{"protocol":"cd-transfer-v1","type":"peer-joined"}""")
                                }
                            }
                        }
                        override fun onMessage(socket: WebSocket, bytes: ByteString) {
                            synchronized(peers) {
                                check(peers.size == 2) { "Record sent before pairing" }
                                peers.getValue(if (role == "sender") "receiver" else "sender").send(bytes)
                            }
                        }
                    }))
                }
                server.start()
                val origin = server.url("/").toString().trimEnd('/')
                CdTransferClient("test.sender", origin).use { sender ->
                    CdTransferClient("test.receiver", origin).use { receiver ->
                        withTimeout(30_000) {
                            val invitation = CompletableDeferred<String>()
                            val bytes = ByteArray(size) { (it % 251).toByte() }
                            val sending = async { sender.send(CdFileSource("pack.stikrpack", "application/zip", size.toLong()) { bytes.inputStream() }, { invitation.complete(it) }) }
                            val output = ByteArrayOutputStream()
                            receiver.receive(invitation.await(), { true }, { output })
                            sending.await()
                            assertArrayEquals(bytes, output.toByteArray())
                        }
                    }
                }
            }
        }
    }
}
