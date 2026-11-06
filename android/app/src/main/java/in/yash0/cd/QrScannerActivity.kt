package `in`.yash0.cd

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.View
import android.widget.Button
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.CaptureManager
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.ViewfinderView
import kotlin.math.roundToInt

/**
 * Portrait QR scanner opened by [MainActivity.scan] through [ScanContract]. It drives zxing's
 * [CaptureManager] with the same calls [com.journeyapps.barcodescanner.CaptureActivity] makes, so the
 * result contract is unchanged: a decoded code returns RESULT_OK and back returns RESULT_CANCELED.
 */
class QrScannerActivity : ComponentActivity() {
    private lateinit var barcodeView: DecoratedBarcodeView
    private lateinit var capture: CaptureManager
    private lateinit var prompt: TextView
    private lateinit var hint: TextView
    private lateinit var torch: ImageButton
    private lateinit var permissionPanel: LinearLayout
    private lateinit var allowButton: Button
    private lateinit var settingsButton: Button
    private lateinit var promptText: String

    private var cameraRunning = false
    private var torchOn = false
    private var permissionDenied = false

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionDenied = !granted
        if (granted) startCamera() else renderPermission()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        setContentView(R.layout.cd_qr_scanner)
        barcodeView = findViewById(R.id.scanner_barcode)
        capture = CaptureManager(this, barcodeView)
        capture.initializeFromIntent(intent, savedInstanceState)
        // zxing can lock the orientation to the rotation the phone had when scanning started, which left
        // the scanner stuck in landscape. The scanner is portrait only, so set it after zxing has run.
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        capture.decode()

        prompt = findViewById(R.id.scanner_prompt)
        hint = findViewById(R.id.scanner_hint)
        torch = findViewById(R.id.scanner_torch)
        permissionPanel = findViewById(R.id.scanner_permission)
        allowButton = findViewById(R.id.scanner_allow)
        settingsButton = findViewById(R.id.scanner_settings)
        promptText = intent.getStringExtra(Intents.Scan.PROMPT_MESSAGE)?.takeIf { it.isNotBlank() }
            ?: getString(R.string.scanner_prompt_default)

        val top = findViewById<View>(R.id.scanner_top)
        val bottom = findViewById<View>(R.id.scanner_bottom)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.scanner_root)) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            top.setPadding(bars.left + dp(12), bars.top + dp(8), bars.right + dp(12), dp(16))
            bottom.setPadding(bars.left + dp(24), dp(48), bars.right + dp(24), bars.bottom + dp(24))
            insets
        }

        findViewById<ImageButton>(R.id.scanner_back).setOnClickListener {
            setResult(RESULT_CANCELED)
            finish()
        }
        if (packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) {
            torch.visibility = View.VISIBLE
            torch.setOnClickListener { if (torchOn) barcodeView.setTorchOff() else barcodeView.setTorchOn() }
        }
        barcodeView.setTorchListener(object : DecoratedBarcodeView.TorchListener {
            override fun onTorchOn() {
                torchOn = true
                renderTorch()
            }

            override fun onTorchOff() {
                torchOn = false
                renderTorch()
            }
        })

        allowButton.setOnClickListener { cameraPermission.launch(Manifest.permission.CAMERA) }
        settingsButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        }
        renderTorch()
        // Ask once on first open; the panel's buttons cover later denials.
        if (savedInstanceState == null && !hasCameraPermission()) cameraPermission.launch(Manifest.permission.CAMERA)
    }

    override fun onResume() {
        super.onResume()
        if (hasCameraPermission()) startCamera() else renderPermission()
    }

    override fun onPause() {
        super.onPause()
        stopCamera()
    }

    override fun onDestroy() {
        super.onDestroy()
        capture.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        capture.onSaveInstanceState(outState)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean =
        barcodeView.onKeyDown(keyCode, event) || super.onKeyDown(keyCode, event)

    private fun hasCameraPermission() =
        checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    // CaptureManager asks for the camera itself when it resumes, so it only runs once permission is granted.
    private fun startCamera() {
        if (cameraRunning) return
        cameraRunning = true
        capture.onResume()
        renderPermission()
        renderTorch()
    }

    private fun stopCamera() {
        if (!cameraRunning) return
        if (torchOn) barcodeView.setTorchOff()
        capture.onPause()
        cameraRunning = false
        renderTorch()
    }

    private fun renderPermission() {
        val granted = hasCameraPermission()
        // After a denial, Android stops showing the system prompt once the user picks "don't ask again".
        val blocked = permissionDenied && !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
        permissionPanel.visibility = if (granted) View.GONE else View.VISIBLE
        hint.visibility = if (granted) View.VISIBLE else View.GONE
        prompt.text = if (granted) promptText else getString(R.string.scanner_permission_title)
        allowButton.visibility = if (blocked) View.GONE else View.VISIBLE
        settingsButton.visibility = if (!granted && blocked) View.VISIBLE else View.GONE
    }

    private fun renderTorch() {
        torch.isSelected = torchOn
        torch.isEnabled = cameraRunning
        torch.contentDescription = getString(if (torchOn) R.string.scanner_flash_off else R.string.scanner_flash_on)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()
}

/**
 * Viewfinder with a clear corner-bracket frame in the app accent instead of zxing's laser line.
 * The dimmed area outside the frame keeps attention on the scan area.
 */
class ScanFrameViewfinderView(context: Context, attrs: AttributeSet) : ViewfinderView(context, attrs) {
    private val density = context.resources.displayMetrics.density
    private val framePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 4 * density
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = context.getColor(R.color.cd_accent)
    }
    private val path = Path()

    init {
        setLaserVisibility(false)
        setMaskColor(0xB80D0503.toInt())
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val frame = framingRect ?: return
        val arm = minOf(frame.width(), frame.height()) / 5f
        val left = frame.left.toFloat()
        val top = frame.top.toFloat()
        val right = frame.right.toFloat()
        val bottom = frame.bottom.toFloat()
        path.reset()
        path.moveTo(left, top + arm)
        path.lineTo(left, top)
        path.lineTo(left + arm, top)
        path.moveTo(right - arm, top)
        path.lineTo(right, top)
        path.lineTo(right, top + arm)
        path.moveTo(right, bottom - arm)
        path.lineTo(right, bottom)
        path.lineTo(right - arm, bottom)
        path.moveTo(left + arm, bottom)
        path.lineTo(left, bottom)
        path.lineTo(left, bottom - arm)
        canvas.drawPath(path, framePaint)
    }
}
