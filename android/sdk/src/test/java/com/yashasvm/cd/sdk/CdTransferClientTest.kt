package com.yashasvm.cd.sdk

import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.OutputStream

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
                            val callerThread = Thread.currentThread()
                            val callbackThreads = mutableListOf<Thread>()
                            val invitation = CompletableDeferred<String>()
                            val bytes = ByteArray(size) { (it % 251).toByte() }
                            val sending = async { sender.send(CdFileSource("pack.stikrpack", "application/zip", size.toLong()) { bytes.inputStream() }, { invitation.complete(it) }, { callbackThreads.add(Thread.currentThread()) }) }
                            val output = ByteArrayOutputStream()
                            receiver.receive(invitation.await(), { true }, { output })
                            sending.await()
                            assertArrayEquals(bytes, output.toByteArray())
                            assertTrue("Progress must stay on the caller thread", callbackThreads.all { it === callerThread })
                        }
                    }
                }
            }
        }
    }

    @Test fun reportsNetworkFailureWhileWaitingForAcceptance() = runBlocking {
        assertSenderDisconnect(cleanClose = false)
    }

    @Test fun reportsRelayCloseWhileWaitingForAcceptance() = runBlocking {
        assertSenderDisconnect(cleanClose = true)
    }

    @Test fun rejectionDoesNotOpenDestination() = runBlocking {
        withOfferedFile { receiver, invitation ->
            var destinationOpened = false
            try {
                withTimeout(2_000) {
                    receiver.receive(invitation, { false }, {
                        destinationOpened = true
                        ByteArrayOutputStream()
                    })
                }
                fail("Rejecting the offer must fail receive")
            } catch (_: CdTransferRejectedException) {
                assertFalse(destinationOpened)
            }
        }
    }

    @Test fun cancellationClosesDestination() = runBlocking {
        withOfferedFile { receiver, invitation ->
            val opened = CompletableDeferred<Unit>()
            var closed = false
            val receiving = async {
                receiver.receive(invitation, { true }, {
                    opened.complete(Unit)
                    object : OutputStream() {
                        override fun write(value: Int) { fail("No file bytes were sent") }
                        override fun close() { closed = true }
                    }
                })
            }
            withTimeout(2_000) { opened.await() }
            receiving.cancelAndJoin()
            assertTrue("Cancellation must close partial output", closed)
        }
    }

    private suspend fun withOfferedFile(block: suspend (CdTransferClient, String) -> Unit) {
        MockWebServer().use { server ->
            server.start()
            val origin = server.url("/").toString().trimEnd('/')
            val invitation = CdInvitation.create(origin)
            val sealer = CdRecordSealer(invitation, sender = true)
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onClosing(socket: WebSocket, code: Int, reason: String) { socket.close(code, "") }
                override fun onMessage(socket: WebSocket, text: String) {
                    socket.send("""{"protocol":"cd-transfer-v1","type":"accepted"}""")
                    socket.send(ByteString.of(*sealer.seal(KIND_OFFER,
                        """{"name":"pack.zip","mediaType":"application/zip","size":"1","chunkSize":262144}""".toByteArray())))
                }
                override fun onMessage(socket: WebSocket, bytes: ByteString) {
                    assertEquals(KIND_ACCEPT, CdRecordOpener(invitation, sender = false).open(bytes.toByteArray()).first)
                }
            }))
            CdTransferClient("test.receiver", origin).use { block(it, invitation.url) }
        }
    }

    private suspend fun assertSenderDisconnect(cleanClose: Boolean) {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(socket: WebSocket, text: String) {
                    socket.send("""{"protocol":"cd-transfer-v1","type":"accepted"}""")
                    socket.send("""{"protocol":"cd-transfer-v1","type":"peer-joined"}""")
                }
                override fun onMessage(socket: WebSocket, bytes: ByteString) {
                    if (cleanClose) socket.close(1008, "rejected") else socket.cancel()
                }
            }))
            server.start()
            CdTransferClient("test.sender", server.url("/").toString().trimEnd('/')).use { sender ->
                var waitingForAcceptance = false
                try {
                    withTimeout(2_000) {
                        sender.send(CdFileSource("empty", "application/octet-stream", 0) { byteArrayOf().inputStream() }, {}, {
                            if (it.phase == CdTransferPhase.WAITING_FOR_ACCEPTANCE) waitingForAcceptance = true
                        })
                    }
                    fail("A disconnected transfer must fail")
                } catch (failure: Exception) {
                    assertTrue("Must reach the acceptance wait", waitingForAcceptance)
                    assertFalse("Disconnect must fail immediately, not time out", failure is TimeoutCancellationException)
                }
            }
        }
    }

}
