package com.signage.player

import android.content.ComponentName
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The whole app is one fullscreen activity that moves through three states:
 * setup (enter server address) -> pairing (show code) -> playback (loop playlist).
 */
class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var cache: ContentCache
    private lateinit var screen: ScreenPlayer

    private lateinit var setupView: View
    private lateinit var serverInput: EditText
    private lateinit var setupError: TextView
    private lateinit var pairingView: View
    private lateinit var pairingCode: TextView
    private lateinit var pairingServer: TextView
    private lateinit var statusView: TextView

    private var runJob: Job? = null
    private var setupResult: CompletableDeferred<String>? = null
    private val tapTimes = ArrayDeque<Long>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        prefs = Prefs(this)
        cache = ContentCache(this)
        screen = ScreenPlayer(this, view(R.id.stage), view(R.id.empty))
        setupView = view(R.id.setup)
        serverInput = view(R.id.server_input)
        setupError = view(R.id.setup_error)
        pairingView = view(R.id.pairing)
        pairingCode = view(R.id.pairing_code)
        pairingServer = view(R.id.pairing_server)
        statusView = view(R.id.status)

        view<Button>(R.id.connect).setOnClickListener { submitServer() }
        serverInput.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) submitServer()
            action == EditorInfo.IME_ACTION_GO
        }

        // Back opens the settings menu instead of quitting, so a stray remote press doesn't blank the screen.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (setupView.visibility == View.VISIBLE) finish() else showMenu()
            }
        })

        hideSystemUi()
        start()
    }

    override fun onDestroy() {
        screen.release()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    /** Remote "menu"/"settings" key opens the menu. */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS) {
            showMenu()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /** Five quick taps anywhere opens the menu on touch screens. */
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.action == MotionEvent.ACTION_DOWN && setupView.visibility != View.VISIBLE) {
            val now = SystemClock.uptimeMillis()
            tapTimes.addLast(now)
            while (tapTimes.isNotEmpty() && now - tapTimes.first() > 3000) tapTimes.removeFirst()
            if (tapTimes.size >= 5) {
                tapTimes.clear()
                showMenu()
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    // ---------- main flow ----------

    private fun start() {
        runJob?.cancel()
        runJob = lifecycleScope.launch {
            // Pauses everything while the app is in the background and resumes when it returns.
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                try {
                    runFlow()
                } finally {
                    screen.stop()
                }
            }
        }
    }

    private suspend fun runFlow() {
        while (true) {
            val server = prefs.serverUrl ?: awaitSetup().also { prefs.serverUrl = it }
            val api = ApiClient(server)
            val token = prefs.deviceToken ?: pair(api, server)
            try {
                playLoop(api, token)
            } catch (e: UnpairedException) {
                // Removed in the CMS: forget everything and show a fresh pairing code.
                screen.stop()
                prefs.unpair()
                cache.prune(emptyList())
            }
        }
    }

    private suspend fun awaitSetup(): String {
        show(setupView)
        if (serverInput.text.isBlank()) serverInput.setText("http://")
        serverInput.setSelection(serverInput.text.length)
        serverInput.requestFocus()
        val result = CompletableDeferred<String>()
        setupResult = result
        return result.await().also { setupResult = null }
    }

    private fun submitServer() {
        var url = serverInput.text.toString().trim().trimEnd('/')
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
        val host = runCatching { java.net.URL(url).host }.getOrNull()
        if (host.isNullOrBlank()) {
            setupError.text = "That doesn't look like a web address."
            return
        }
        setupError.text = ""
        setupResult?.complete(url)
    }

    /** Shows a pairing code until an admin claims it in the CMS. Returns the device token. */
    private suspend fun pair(api: ApiClient, server: String): String {
        show(pairingView)
        pairingServer.text = server
        while (true) {
            try {
                pairingCode.text = "······"
                val reg = api.register(deviceInfo())
                pairingCode.text = reg.code
                hideStatus()
                while (true) {
                    delay(3000)
                    when (val s = api.pairStatus(reg.pollToken)) {
                        is PairStatus.Paired -> {
                            prefs.deviceToken = s.deviceToken
                            prefs.deviceName = s.deviceName
                            return s.deviceToken
                        }
                        PairStatus.Expired -> break // get a fresh code
                        is PairStatus.Pending -> Unit
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                showStatus("Can't reach $server. Retrying… (press Back or tap 5 times for settings)")
                delay(10_000)
            }
        }
    }

    /** Keeps the content in sync with the CMS and playing. Runs until cancelled or the device is unpaired. */
    private suspend fun playLoop(api: ApiClient, token: String): Unit = coroutineScope {
        show(null)
        var manifest: Manifest? = null
        // What's on screen now: manifest version + program, so either changing restarts playback.
        var showing: String? = null

        fun showActive() {
            val m = manifest ?: return
            val program = m.activeProgram()
            val key = m.version + "/" + program?.id
            if (key == showing) return
            val files = m.media.associateBy { it.mediaId }
            screen.play(this, program) { id -> files[id]?.takeIf { cache.isCached(it) }?.let { cache.fileFor(it) } }
            showing = key
        }

        // Start straight away from what's on disk, so a reboot without network still shows content.
        prefs.manifestJson?.let { json ->
            val m = runCatching { Manifest.parse(json) }.getOrNull()
            if (m != null && m.media.all { cache.isCached(it) }) {
                manifest = m
                showActive()
            }
        }

        // Remote commands already carried out by this run, so a slow acknowledgement doesn't run one twice.
        val handled = HashSet<String>()

        while (true) {
            var pollSeconds = 30
            var refresh = false
            try {
                val json = api.manifest(token)
                val m = Manifest.parse(json)
                pollSeconds = m.pollSeconds
                for (cmd in m.commands) {
                    if (handled.add(cmd.id)) refresh = runCommand(api, token, cmd, handled) || refresh
                }
                if (refresh) {
                    // Start over: re-check every file and play from the top.
                    manifest = null
                    showing = null
                    screen.stop()
                    continue
                }
                if (m.version != manifest?.version) {
                    cache.sync(api, token, m.media) { done, total, bytes ->
                        // Only show progress on a blank screen; never draw over live content.
                        if (showing == null) runOnUiThread {
                            showStatus("Downloading ${done + 1} of $total (${bytes / 1_000_000} MB)")
                        }
                    }
                    prefs.manifestJson = json
                    manifest = m
                    showActive() // switch over before deleting files the old content used
                    cache.prune(m.media)
                }
                hideStatus()
            } catch (e: CancellationException) {
                throw e
            } catch (e: UnpairedException) {
                throw e
            } catch (e: IOException) {
                if (showing == null) showStatus("Waiting for the server… ${e.message ?: ""}")
                pollSeconds = 15
            } catch (e: Exception) {
                if (showing == null) showStatus("Problem loading content: ${e.message}")
                pollSeconds = 15
            }
            showActive()
            delay(pollSeconds * 1000L)
        }
    }

    // ---------- remote commands ----------

    /** Carries out one command from the CMS. Returns true if playback should start over. */
    private suspend fun runCommand(api: ApiClient, token: String, cmd: Command, handled: MutableSet<String>): Boolean {
        suspend fun report(ok: Boolean, message: String): Boolean = try {
            api.commandDone(token, cmd.id, ok, message)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: UnpairedException) {
            throw e
        } catch (e: Exception) {
            false
        }

        when (cmd.type) {
            "refresh" -> {
                report(true, "Content refreshed")
                return true
            }
            "screenshot" -> try {
                api.uploadScreenshot(token, captureScreenJpeg())
            } catch (e: CancellationException) {
                throw e
            } catch (e: UnpairedException) {
                throw e
            } catch (e: Exception) {
                report(false, "Screenshot failed: ${e.message}")
            }
            // Only restart once the CMS knows, or the new app would see the same command and restart again.
            "restart" -> if (report(true, "Restarting the app")) restartApp() else handled.remove(cmd.id)
            "reboot" -> {
                if (!report(true, "Rebooting")) {
                    handled.remove(cmd.id)
                    return false
                }
                withContext(Dispatchers.IO) {
                    runCatching { Runtime.getRuntime().exec(arrayOf("su", "-c", "reboot")).waitFor() }
                }
                delay(10_000)
                // Still running, so the reboot didn't happen. Most devices only allow it with root.
                report(false, "This device can't be rebooted remotely (it needs root), so the app was restarted instead.")
                restartApp()
            }
            else -> report(false, "This player version doesn't support \"${cmd.type}\". Update the app.")
        }
        return false
    }

    private fun restartApp() {
        startActivity(Intent.makeRestartActivityTask(ComponentName(this, MainActivity::class.java)))
        Runtime.getRuntime().exit(0)
    }

    /** A picture of what's on screen, video and web pages included where the device allows. */
    private suspend fun captureScreenJpeg(): ByteArray {
        val root = window.decorView
        val bitmap = Bitmap.createBitmap(root.width.coerceAtLeast(1), root.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            suspendCancellableCoroutine { cont ->
                PixelCopy.request(window, bitmap, { result ->
                    if (result == PixelCopy.SUCCESS) cont.resume(Unit)
                    else cont.resumeWithException(IOException("PixelCopy error $result"))
                }, Handler(Looper.getMainLooper()))
            }
        } else {
            // Older Android can only draw ordinary views; video areas come out black.
            root.draw(Canvas(bitmap))
        }
        return withContext(Dispatchers.Default) {
            val scale = minOf(1f, 1280f / bitmap.width)
            val small = if (scale < 1f) {
                Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true)
            } else {
                bitmap
            }
            ByteArrayOutputStream().also { small.compress(Bitmap.CompressFormat.JPEG, 75, it) }.toByteArray()
        }
    }

    private fun deviceInfo() = mapOf(
        "manufacturer" to Build.MANUFACTURER,
        "model" to Build.MODEL,
        "android" to Build.VERSION.RELEASE,
        "appVersion" to BuildConfig.VERSION_NAME,
    )

    // ---------- UI helpers ----------

    /** Shows one of the full-screen panels, or none (playback). */
    private fun show(panel: View?) {
        setupView.visibility = if (panel == setupView) View.VISIBLE else View.GONE
        pairingView.visibility = if (panel == pairingView) View.VISIBLE else View.GONE
        hideStatus()
    }

    private fun showStatus(text: String) {
        statusView.text = text
        statusView.visibility = View.VISIBLE
    }

    private fun hideStatus() {
        statusView.visibility = View.GONE
    }

    private fun showMenu() {
        val name = prefs.deviceName?.let { " · $it" } ?: ""
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.menu_title) + name)
            .setItems(arrayOf(getString(R.string.menu_change_server), getString(R.string.menu_unpair), "Exit player")) { _, which ->
                when (which) {
                    0 -> {
                        prefs.unpair()
                        prefs.serverUrl?.let { serverInput.setText(it) }
                        prefs.serverUrl = null
                        cache.prune(emptyList())
                        start()
                    }
                    1 -> {
                        prefs.unpair()
                        cache.prune(emptyList())
                        start()
                    }
                    2 -> finish()
                }
            }
            .setNegativeButton(R.string.menu_cancel, null)
            .show()
    }

    private fun <T : View> view(id: Int): T = checkNotNull(findViewById<T>(id))

    private fun hideSystemUi() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }
}
