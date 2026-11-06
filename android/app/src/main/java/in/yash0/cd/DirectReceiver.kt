package `in`.yash0.cd

import android.content.Context
import org.json.JSONObject
import org.webrtc.*
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

class DirectReceiver(
    private val context: Context,
    private val allowMobile: Boolean,
    private val sendSignal: (JSONObject) -> Unit,
    private val record: (ByteArray) -> Unit,
    private val abort: (IOException) -> Unit,
    private val diagnostic: (String) -> Unit
): Closeable {
    private val executor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "CD-WebRTC") }
    private val closed = AtomicBoolean(false)
    private val failed = AtomicBoolean(false)
    private val used = AtomicBoolean(false)
    private val assembler = DirectRecords()
    private var factory: PeerConnectionFactory? = null
    private var connection: PeerConnection? = null
    private var channel: DataChannel? = null
    private var answerSent = false
    private var candidateCount = 0
    private val pendingCandidates = ArrayList<JSONObject>()

    fun start(sdp: String) {
        if (sdp.isEmpty() || sdp.toByteArray().size > 65536) { fail(); return }
        execute {
            Runtime.initialize(context)
            val options = PeerConnectionFactory.Options().apply {
                networkIgnoreMask = NativeNetworkPolicy.ignoreMask(allowMobile)
                disableNetworkMonitor = false
            }
            factory = PeerConnectionFactory.builder().setOptions(options).setFieldTrials("WebRTC-AndroidNetworkMonitor-IsAdapterAvailable/Enabled/").createPeerConnectionFactory()
            val config = PeerConnection.RTCConfiguration(listOf(PeerConnection.IceServer.builder(listOf("stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478")).createIceServer())).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                enableIceGatheringOnAnyAddressPorts = false
            }
            val peer = factory!!.createPeerConnection(config, observer) ?: throw IOException("Could not create direct peer")
            connection = peer
            channel = peer.createDataChannel("cd-direct", DataChannel.Init().apply { negotiated = true; id = 1; ordered = true }) ?: throw IOException("Could not create direct channel")
            channel!!.registerObserver(dataObserver)
            peer.setRemoteDescription(object: DescriptionObserver() {
                override fun onSetSuccess() = execute {
                    peer.createAnswer(object: DescriptionObserver() {
                        override fun onCreateSuccess(answer: SessionDescription) = execute {
                            require(answer.description.toByteArray().size <= 65536)
                            peer.setLocalDescription(object: DescriptionObserver() {
                                override fun onSetSuccess() = execute {
                                    sendSignal(JSONObject().put("sdp", answer.description))
                                    answerSent = true
                                    pendingCandidates.forEach(sendSignal)
                                    pendingCandidates.clear()
                                    diagnostic("direct-answer-sent")
                                }
                            }, answer)
                        }
                    }, MediaConstraints())
                }
            }, SessionDescription(SessionDescription.Type.OFFER, sdp))
            diagnostic("direct-negotiating")
        }
    }
    private fun execute(action: () -> Unit) {
        if (closed.get()) return
        try { executor.execute {
            if (!closed.get()) try { action() } catch (_: Exception) { fail() } catch (_: LinkageError) { fail() }
        } } catch (_: RejectedExecutionException) { }
    }
    private fun fail() {
        if (closed.get() || !failed.compareAndSet(false, true)) return
        if (used.get()) {
            diagnostic("direct-lost")
            // Release any callback waiting on the bounded inbox before native disposal.
            abort(IOException("Direct transfer interrupted; saved progress is available"))
        } else diagnostic("direct-unavailable-relay-continues")
        close()
    }
    private val observer = object: PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            if (state in listOf(PeerConnection.IceConnectionState.FAILED, PeerConnection.IceConnectionState.DISCONNECTED, PeerConnection.IceConnectionState.CLOSED)) fail()
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onIceCandidate(candidate: IceCandidate) = execute {
            if (candidateCount >= 64 || candidate.sdp.length > 1024) return@execute
            if (!allowMobile && candidate.adapterType !in listOf(PeerConnection.AdapterType.WIFI, PeerConnection.AdapterType.ETHERNET)) return@execute
            candidateCount++
            val signal = JSONObject().put("candidate", JSONObject().put("candidate", candidate.sdp).put("sdpMid", candidate.sdpMid).put("sdpMLineIndex", candidate.sdpMLineIndex))
            if (answerSent) sendSignal(signal) else pendingCandidates.add(signal)
        }
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(unexpected: DataChannel) { execute { unexpected.close(); unexpected.dispose() } }
        override fun onRenegotiationNeeded() {}
    }
    private val dataObserver = object: DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) {}
        override fun onStateChange() {
            if (closed.get()) return
            when (channel?.state()) {
                DataChannel.State.OPEN -> diagnostic("direct-open")
                DataChannel.State.CLOSING, DataChannel.State.CLOSED -> fail()
                else -> {}
            }
        }
        override fun onMessage(buffer: DataChannel.Buffer) {
            if (closed.get()) return
            if (used.compareAndSet(false, true)) diagnostic("direct-receiving")
            try {
                require(buffer.binary && buffer.data.remaining() in 1..65536)
                val copy = ByteArray(buffer.data.remaining())
                buffer.data.get(copy)
                assembler.push(copy, record)
            } catch (_: Exception) { fail() }
        }
    }
    private open inner class DescriptionObserver: SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String) { fail() }
        override fun onSetFailure(error: String) { fail() }
    }
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        // Never dispose synchronously from a libwebrtc callback; its network thread may
        // be returning from a bounded inbox wait while the native peer is shutting down.
        executor.execute {
            runCatching { channel?.unregisterObserver(); channel?.close(); channel?.dispose() }
            runCatching { connection?.close(); connection?.dispose() }
            runCatching { factory?.dispose() }
            pendingCandidates.clear()
        }
        executor.shutdown()
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
