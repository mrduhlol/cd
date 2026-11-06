package `in`.yash0.cd

import android.app.Instrumentation
import android.app.Activity
import android.app.Application
import java.util.concurrent.atomic.AtomicInteger
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.graphics.Rect
import android.util.Xml
import android.view.accessibility.AccessibilityNodeInfo
import java.io.StringWriter
import java.io.File
import org.json.JSONObject

/** Local emulator-only driver. No debug control entry points are shipped in the application. */
class SendInstrumentation : Instrumentation() {
    private lateinit var args: Bundle
    private var activity: MainActivity? = null
    private val activityCreates = AtomicInteger()
    private val activityResumes = AtomicInteger()
    override fun onCreate(arguments: Bundle) { args = arguments; start() }
    override fun onStart() {
        try {
            val context = targetContext
            (context.applicationContext as Application).registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
                override fun onActivityCreated(a: Activity, state: Bundle?) { if (a is MainActivity) activityCreates.incrementAndGet() }
                override fun onActivityResumed(a: Activity) { if (a is MainActivity) activityResumes.incrementAndGet() }
                override fun onActivityStarted(a: Activity) {}
                override fun onActivityPaused(a: Activity) {}
                override fun onActivityStopped(a: Activity) {}
                override fun onActivitySaveInstanceState(a: Activity, state: Bundle) {}
                override fun onActivityDestroyed(a: Activity) {}
            })
            val monitor = addMonitor(MainActivity::class.java.name, null, false)
            context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            activity = waitForMonitorWithTimeout(monitor, 180000) as? MainActivity
            removeMonitor(monitor)
            check(activity != null) { "Main activity did not start" }
            val engine = SendEngineImpl(context, args.getString("base", "http://127.0.0.1:8788"), args.getString("direct", "false") == "true")
            TransferBus.sender = engine
            if (args.getString("action") == "controls") { controls(engine); return }
            val id = if (args.getString("action", "start") == "resume") args.getString("id")!!.also { engine.resume(context, it) }
                else engine.start(context, listOf(Uri.fromFile(File(args.getString("source")!!))))
            File(context.filesDir, "send-test-id").writeText(id)
            var nextTreeAt = 0L
            val deadline = System.currentTimeMillis() + 15 * 60 * 1000
            while (System.currentTimeMillis() < deadline) {
                if (System.currentTimeMillis() >= nextTreeAt) {
                    exportTree()
                    nextTreeAt = System.currentTimeMillis() + 400
                }
                val view = TransferBus.find(id, Direction.SEND)
                if (view != null) {
                    File(context.filesDir, "send-test-status.json").writeText(JSONObject().put("id", id).put("phase", view.phase.name).put("done", view.done).put("link", view.link).put("rate", view.bytesPerSecond).put("route", view.route.name).put("message", view.message).put("activityCreates", activityCreates.get()).put("activityResumes", activityResumes.get()).toString())
                    if (view.phase == TransferPhase.COMPLETE) { finish(0, Bundle().apply { putString("result", "complete") }); return }
                    if (view.phase in listOf(TransferPhase.PAUSED, TransferPhase.FAILED)) {
                        if (args.getString("action") == "failure") {
                            check(view.link == null) { "Unaccepted failure exposed invitation" }
                            check(view.message?.contains(args.getString("expected", "")) == true) { "Unexpected actionable failure: ${view.message}" }
                            check(view.message?.contains("#v2.") != true)
                            finish(0, Bundle().apply { putString("result", "expected failure, no premature invitation") }); return
                        }
                        error(view.message ?: view.phase.name)
                    }
                }
                Thread.sleep(50)
            }
            error("Timed out")
        } catch (e: Exception) { finish(1, Bundle().apply { putString("error", e.stackTraceToString()) }) }
    }
    // Read accessibility directly: uiautomator dump waits for global UI idle, which a
    // legitimate pulsing waiting indicator need never reach. Test APK only.
    private fun exportTree() {
        runCatching {
            val root = uiAutomation.rootInActiveWindow ?: return
            val text = StringWriter()
            val xml = Xml.newSerializer().apply { setOutput(text); startDocument("UTF-8", true) }
            fun visit(node: AccessibilityNodeInfo) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                xml.startTag(null, "node")
                xml.attribute(null, "text", node.text?.toString().orEmpty())
                xml.attribute(null, "content-desc", node.contentDescription?.toString().orEmpty())
                xml.attribute(null, "bounds", "[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]")
                for (index in 0 until node.childCount) node.getChild(index)?.let { visit(it) }
                xml.endTag(null, "node")
            }
            xml.startTag(null, "hierarchy"); visit(root); xml.endTag(null, "hierarchy"); xml.endDocument()
            val pending = File(targetContext.filesDir, "send-test-tree.tmp")
            pending.writeText(text.toString())
            check(pending.renameTo(File(targetContext.filesDir, "send-test-tree.xml")))
        }
    }
    private fun controls(engine: SendEngineImpl) {
        val file = File(targetContext.filesDir, "controls.txt").apply { writeText("sender control check") }
        val id = engine.start(targetContext, listOf(Uri.fromFile(file)))
        fun waitFor(phase: TransferPhase) {
            val deadline = System.currentTimeMillis() + 90000
            while (System.currentTimeMillis() < deadline) {
                if (TransferBus.transfers.value.first { it.id == id }.phase == phase) return
                Thread.sleep(20)
            }
            error("Expected $phase: ${TransferBus.transfers.value.first { it.id == id }}")
        }
        waitFor(TransferPhase.WAITING)
        val invitation = TransferBus.find(id, Direction.SEND)!!.link
        check(invitation != null)
        check(engine.owns(id))
        runOnMainSync { activity!!.submit(invitation) }
        Thread.sleep(500)
        check(TransferBus.find(id, Direction.RECEIVE) == null) { "Own invitation entered receive queue" }
        check(TransferBus.find(id, Direction.SEND)?.phase == TransferPhase.WAITING)
        engine.pause(targetContext, id)
        waitFor(TransferPhase.PAUSED)
        check(TransferBus.find(id, Direction.SEND)!!.link == invitation)
        engine.resume(targetContext, id)
        waitFor(TransferPhase.WAITING)
        check(TransferBus.find(id, Direction.SEND)!!.link == invitation)
        engine.cancel(targetContext, id)
        waitFor(TransferPhase.CANCELLED)
        check(TransferBus.find(id, Direction.SEND)!!.link == null)
        engine.pause(targetContext, id)
        check(runCatching { engine.resume(targetContext, id) }.isFailure)
        Thread.sleep(500)
        check(SenderStore(targetContext).load(id).getString("phase") == "CANCELLED")
        check(!SenderStore(targetContext).source(id).exists())
        check(TransferBus.transfers.value.first { it.id == id }.phase == TransferPhase.CANCELLED)
        finish(0, Bundle().apply { putString("result", "self-receive guard, pause, immediate resume, cancel, retained cancellation and source cleanup passed") })
    }
}
