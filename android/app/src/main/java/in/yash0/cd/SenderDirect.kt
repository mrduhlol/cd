package `in`.yash0.cd

import android.content.Context
import org.json.JSONObject
import org.webrtc.*
import java.io.Closeable
import java.io.IOException
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** The offer contains gathered ICE candidates; only the receiver trickles kind-9 signals. */
internal class SenderDirect(private val context: Context, private val abort: (IOException) -> Unit) : Closeable {
    private val closed = AtomicBoolean(false)
    private val failed = AtomicBoolean(false)
    private val used = AtomicBoolean(false)
    private val gathered = CountDownLatch(1)
    private val disposal = Executors.newSingleThreadExecutor { Thread(it, "CD-Send-WebRTC-dispose") }
    private var factory: PeerConnectionFactory? = null
    @Volatile private var peer: PeerConnection? = null
    @Volatile private var channel: DataChannel? = null
    private var answered = false
    private var answering = false
    private var candidates = 0
    private val pending = ArrayList<IceCandidate>()
    fun offer(): String? = try {
        Runtime.initialize(context)
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        val config = PeerConnection.RTCConfiguration(listOf(PeerConnection.IceServer.builder(listOf("stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478")).createIceServer())).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val connection = factory!!.createPeerConnection(config, observer) ?: throw IOException("Cannot create direct peer")
        peer = connection
        channel = connection.createDataChannel("cd-direct", DataChannel.Init().apply { negotiated = true; id = 1; ordered = true }) ?: throw IOException("Cannot create direct channel")
        channel!!.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() { if (channel?.state() in listOf(DataChannel.State.CLOSING, DataChannel.State.CLOSED)) fail() }
            override fun onMessage(buffer: DataChannel.Buffer) { fail() }
        })
        val described = CountDownLatch(1)
        connection.createOffer(object : DescriptionObserver() {
            override fun onCreateSuccess(description: SessionDescription) {
                connection.setLocalDescription(object : DescriptionObserver() { override fun onSetSuccess() { described.countDown() } }, description)
            }
        }, MediaConstraints())
        require(described.await(5, TimeUnit.SECONDS) && !failed.get())
        gathered.await(2, TimeUnit.SECONDS)
        connection.localDescription?.description?.also { require(it.isNotEmpty() && it.toByteArray().size <= 65536) }
    } catch (_: Exception) { fail(); null } catch (_: LinkageError) { fail(); null }
    @Synchronized fun signal(signal: JSONObject) {
        if (closed.get() || failed.get()) return
        try {
            require(signal.toString().toByteArray().size <= 69632)
            if (signal.has("candidate")) {
                require(++candidates <= 64)
                val c = signal.getJSONObject("candidate")
                val sdp = c.getString("candidate")
                require(sdp.length <= 1024)
                val candidate = IceCandidate(c.optString("sdpMid", "0"), c.optInt("sdpMLineIndex", 0), sdp)
                if (!answered) pending.add(candidate) else peer!!.addIceCandidate(candidate)
            } else {
                require(!answering)
                val sdp = signal.getString("sdp")
                require(sdp.isNotEmpty() && sdp.toByteArray().size <= 65536)
                answering = true
                peer!!.setRemoteDescription(object : DescriptionObserver() {
                    override fun onSetSuccess() {
                        synchronized(this@SenderDirect) {
                            if (closed.get()) return
                            answered = true
                            pending.forEach { peer!!.addIceCandidate(it) }
                            pending.clear()
                        }
                    }
                }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
            }
        } catch (_: Exception) { fail() }
    }
    fun ready(): Boolean = !closed.get() && !failed.get() && channel?.state() == DataChannel.State.OPEN
    fun markUsed() { used.set(true); check(ready()) { "Direct connection interrupted" } }
    fun send(record: ByteArray, active: () -> Unit) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90)
        var offset = 0
        while (offset < record.size) {
            active()
            check(ready()) { "Direct connection interrupted. Resume to continue." }
            val data = channel!!
            while (data.bufferedAmount() > 1024 * 1024) {
                active(); check(ready() && System.nanoTime() < deadline) { "Direct connection stalled" }; Thread.sleep(2)
            }
            val n = minOf(16384, record.size - offset)
            check(data.send(DataChannel.Buffer(ByteBuffer.wrap(record, offset, n).slice(), true))) { "Direct send failed" }
            offset += n
        }
    }
    private fun fail() {
        if (closed.get() || !failed.compareAndSet(false, true)) return
        gathered.countDown()
        if (used.get()) abort(IOException("Direct connection interrupted. Resume to continue."))
        // Native disposal must not run on its own network callback thread.
        close()
    }
    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) { if (state in listOf(PeerConnection.IceConnectionState.CLOSED, PeerConnection.IceConnectionState.DISCONNECTED, PeerConnection.IceConnectionState.FAILED)) fail() }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.countDown() }
        override fun onIceCandidate(candidate: IceCandidate) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(unexpected: DataChannel) { fail() }
        override fun onRenegotiationNeeded() {}
    }
    private open inner class DescriptionObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String) { fail() }
        override fun onSetFailure(error: String) { fail() }
    }
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        disposal.execute {
            runCatching { channel?.unregisterObserver(); channel?.close(); channel?.dispose() }
            runCatching { peer?.close(); peer?.dispose() }
            runCatching { factory?.dispose() }
        }
        disposal.shutdown()
    }
    private object Runtime {
        private var initialized = false
        @Synchronized fun initialize(context: Context) {
            if (!initialized) {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).setEnableInternalTracer(false).createInitializationOptions())
                NetworkMonitor.getInstance().setNetworkChangeDetectorFactory { observer, appContext -> NativeNetworkDetector(observer, appContext) }
                initialized = true
            }
        }
    }
}
