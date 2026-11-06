package `in`.yash0.cd

import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString.Companion.toByteString
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class WireTest {
    @Test fun terminalFrameSurvivesPeerCloseBeforeConsumerReads() {
        val closed = CountDownLatch(1)
        val server = MockWebServer()
        val client = OkHttpClient()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(byteArrayOf(6, 1, 2).toByteString())
                webSocket.close(1000, "complete")
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.countDown() }
        }))
        server.start()
        try {
            Wire(client, server.url("/ws/v1/test").newBuilder().host("127.0.0.1").build().toString().replace("http://", "ws://")) {}.use { wire ->
                // Wait for the peer close to reach the inbox before consuming its final frame.
                assertTrue(closed.await(5, TimeUnit.SECONDS))
                assertArrayEquals(byteArrayOf(6, 1, 2), (wire.next(5) as Frame.Binary).bytes)
                val eof = assertThrows(WireFailure::class.java) { wire.next(5) }
                assertEquals("closed", eof.phase)
                assertEquals(1000, eof.status)
            }
        } finally {
            client.dispatcher.executorService.shutdownNow()
            client.connectionPool.evictAll()
            server.shutdown()
        }
    }
}
