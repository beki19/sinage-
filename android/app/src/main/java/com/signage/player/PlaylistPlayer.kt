package com.signage.player

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.animation.LinearInterpolator
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.annotation.OptIn
import androidx.appcompat.widget.AppCompatTextView
import androidx.core.view.doOnLayout
import androidx.core.widget.TextViewCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DefaultRenderersFactory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** What a zone needs from the screen around it. */
interface ZoneHost {
    /** How video is drawn: VideoView.MODE_SURFACE, or MODE_TEXTURE after the surface stayed black on this device. */
    var videoMode: String

    /** What the zone is doing now, for the CMS's live status: loading, playing, idle or error. */
    fun report(zoneId: String, item: Item?, state: String, error: String? = null)

    /** Size and codec of a video, when the CMS knows them. */
    fun media(mediaId: String): MediaFile?

    /** Proof of play: [item] was on screen for [seconds], counting as [plays] showings. */
    fun played(item: Item, seconds: Int, plays: Int)
}

/** Video that never showed a picture, so the next attempt can try another way of drawing it. */
class NoPictureException : Exception("The video never showed a picture")

/**
 * Loops one zone's items inside [container]: images in an ImageView, videos and live streams in ExoPlayer,
 * web pages and YouTube in a WebView, text and tickers in a TextView. Views are created when first needed.
 */
@OptIn(UnstableApi::class)
class PlaylistPlayer(
    private val context: Context,
    private val container: FrameLayout,
    private val withSound: Boolean,
    /** CMS address: the origin for world clock and news pages, so they can fetch headlines from it. */
    private val serverUrl: String,
    private val deviceToken: String,
    private val zoneId: String,
    private val host: ZoneHost,
) {
    private val imageView = ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_CENTER
        visibility = View.INVISIBLE
    }
    private val textView = AppCompatTextView(context).apply { gravity = Gravity.CENTER }
    private val textBox = FrameLayout(context).apply {
        visibility = View.INVISIBLE
        addView(textView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    }
    private var exo: ExoPlayer? = null
    private var videoView: VideoView? = null
    private var webView: WebView? = null
    private var pageLoaded: CompletableDeferred<Unit>? = null
    private var ticker: ValueAnimator? = null
    private var job: Job? = null

    init {
        container.addView(imageView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        container.addView(textBox, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    }

    /** Replaces whatever is playing and starts [items] from the top. [fileFor] maps a media id to its file on disk. */
    fun play(scope: CoroutineScope, items: List<Item>, fileFor: (String) -> File?) {
        job?.cancel()
        job = scope.launch {
            try {
                loop(items, fileFor)
            } finally {
                exo?.stop()
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        blank()
    }

    fun release() {
        stop()
        videoView?.release()
        exo?.release()
        exo = null
        webView?.destroy()
        webView = null
    }

    private suspend fun loop(items: List<Item>, fileFor: (String) -> File?) {
        var shownAlone: Item? = null
        // Every step suspends (delay or playback), so cancellation always gets through.
        while (true) {
            val now = System.currentTimeMillis()
            val active = items.filter { it.isActiveAt(now) && (it.mediaId == null || fileFor(it.mediaId) != null) }
            when {
                active.isEmpty() -> {
                    shownAlone = null
                    blank()
                    host.report(zoneId, null, "idle")
                    delay(10_000)
                }
                // A single item never needs to change: show it once and just re-check the dates now and then.
                active.size == 1 && active[0].kind != "stream" -> {
                    val only = active[0]
                    if (only != shownAlone) {
                        shownAlone = only
                        aloneOk = false
                        aloneSeconds = 0
                        try {
                            host.report(zoneId, only, "loading")
                            showAlone(only, fileFor)
                            host.report(zoneId, only, "playing")
                            aloneOk = true
                            host.played(only, 0, 1)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            Log.w(TAG, "Cannot show ${only.kind} ${only.id}", e)
                            host.report(zoneId, only, "error", describe(only, e))
                            blank()
                        }
                    }
                    val started = System.currentTimeMillis()
                    delay(10_000)
                    if (aloneOk) countAlone(only, ((System.currentTimeMillis() - started) / 1000).toInt())
                }
                else -> {
                    shownAlone = null
                    for (item in active) {
                        if (!item.isActiveAt(System.currentTimeMillis())) continue
                        try {
                            host.report(zoneId, item, "loading")
                            val started = System.currentTimeMillis()
                            showFor(item, alone = active.size == 1, fileFor)
                            host.played(item, ((System.currentTimeMillis() - started) / 1000).toInt(), 1)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            // Skip a broken item rather than stopping the whole screen.
                            Log.w(TAG, "Skipping ${item.kind} ${item.id}", e)
                            host.report(zoneId, item, "error", describe(item, e))
                            delay(if (item.kind == "stream") 5000 else 1000)
                        }
                    }
                }
            }
        }
    }

    // An item alone in its zone stays up; each full run of its length counts as another showing.
    private var aloneOk = false
    private var aloneSeconds = 0

    private fun countAlone(item: Item, seconds: Int) {
        val unit = if (item.kind == "video") (exo?.duration ?: 0L).let { if (it > 0) (it / 1000).toInt() else item.duration } else item.duration
        val before = aloneSeconds / unit.coerceAtLeast(1)
        aloneSeconds += seconds
        host.played(item, seconds, aloneSeconds / unit.coerceAtLeast(1) - before)
    }

    /** Shows the only item in the zone and returns once it's up; it stays until something else is shown. */
    private suspend fun showAlone(item: Item, fileFor: (String) -> File?) {
        when (item.kind) {
            "image" -> showImage(fileFor(item.mediaId!!)!!)
            "video" -> {
                ensureExo().repeatMode = Player.REPEAT_MODE_ONE
                playVideo(MediaItem.fromUri(Uri.fromFile(fileFor(item.mediaId!!)!!)), untilEnded = false)
            }
            "text" -> showText(item)
            "web", "youtube", "html" -> showWeb(item)
        }
    }

    /** Shows one item for its turn in the loop and returns when the next one should come on. */
    private suspend fun showFor(item: Item, alone: Boolean, fileFor: (String) -> File?) {
        when (item.kind) {
            "image" -> {
                showImage(fileFor(item.mediaId!!)!!)
                host.report(zoneId, item, "playing")
                delay(item.duration * 1000L)
            }
            "video" -> {
                ensureExo().repeatMode = Player.REPEAT_MODE_OFF
                playVideo(MediaItem.fromUri(Uri.fromFile(fileFor(item.mediaId!!)!!)), untilEnded = true) {
                    host.report(zoneId, item, "playing")
                }
            }
            "stream" -> {
                ensureExo().repeatMode = Player.REPEAT_MODE_OFF
                val media = streamItem(item.url)
                // On its own, a live stream plays nonstop; in a loop it gets its set time.
                val onStart = { host.report(zoneId, item, "playing") }
                if (alone) playVideo(media, untilEnded = true, onStart)
                else withTimeoutOrNull(item.duration * 1000L) { playVideo(media, untilEnded = true, onStart) }
            }
            "text" -> {
                showText(item)
                host.report(zoneId, item, "playing")
                delay(item.duration * 1000L)
            }
            "web", "youtube", "html" -> {
                showWeb(item)
                host.report(zoneId, item, "playing")
                delay(item.duration * 1000L)
            }
        }
    }

    // ---------- images ----------

    private suspend fun showImage(file: File) {
        val bitmap = withContext(Dispatchers.IO) { decodeForScreen(file) }
            ?: throw IllegalStateException("Cannot decode ${file.name}")
        imageView.setImageBitmap(bitmap)
        reveal(imageView)
    }

    /** Decodes at roughly zone resolution so a 6000px photo doesn't run a TV box out of memory. */
    private fun decodeForScreen(file: File): Bitmap? {
        val metrics = context.resources.displayMetrics
        val targetW = container.width.takeIf { it > 0 } ?: maxOf(metrics.widthPixels, metrics.heightPixels)
        val targetH = container.height.takeIf { it > 0 } ?: minOf(metrics.widthPixels, metrics.heightPixels)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= targetW && bounds.outHeight / (sample * 2) >= targetH) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    // ---------- video and live streams ----------

    private fun ensureExo(): ExoPlayer = exo ?: ExoPlayer.Builder(
        context,
        // If the device's first-choice decoder can't open a video, try the next one instead of failing.
        DefaultRenderersFactory(context).setEnableDecoderFallback(true),
    ).build().also { player ->
        player.volume = if (withSound) 1f else 0f
        exo = player
        attachVideoView(host.videoMode)
    }

    /** Puts a video view at the bottom of the zone. It stays visible: a hidden SurfaceView has nothing to draw the first frame on. */
    private fun attachVideoView(mode: String) {
        val player = exo ?: return
        videoView?.let {
            it.release()
            container.removeView(it)
        }
        videoView = VideoView(context, player, mode).also {
            container.addView(it, 0, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
    }

    /**
     * Plays a video, and if it never shows a picture with the usual SurfaceView, switches this device to
     * TextureView (which some TVs need) and tries once more. [onStart] runs when the picture appears.
     */
    private suspend fun playVideo(media: MediaItem, untilEnded: Boolean, onStart: () -> Unit = {}) {
        ensureExo()
        try {
            playMedia(media, untilEnded, onStart)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (videoView?.mode != VideoView.MODE_SURFACE || (e !is NoPictureException && e !is PlaybackException)) throw e
            Log.w(TAG, "No picture with SurfaceView, trying TextureView", e)
            host.videoMode = VideoView.MODE_TEXTURE
            attachVideoView(VideoView.MODE_TEXTURE)
            playMedia(media, untilEnded, onStart)
        }
    }

    /** Explains a failed item in words for the CMS, e.g. that the TV can't decode 4K. */
    private fun describe(item: Item, e: Exception): String {
        if (item.kind == "video") {
            val m = item.mediaId?.let { host.media(it) }
            if (m != null) VideoSupport.problem(m.codec, m.width, m.height)?.let { return it }
            if (e is NoPictureException) return "The video plays but shows no picture on this screen"
        }
        return (e as? PlaybackException)?.let { "${it.errorCodeName}: ${it.message ?: ""}".trim() } ?: (e.message ?: e.javaClass.simpleName)
    }

    private fun streamItem(url: String): MediaItem {
        val b = MediaItem.Builder().setUri(url)
        if (url.contains(".m3u8", ignoreCase = true)) b.setMimeType(MimeTypes.APPLICATION_M3U8)
        return b.build()
    }

    /**
     * Starts playback and, once the first frame is rendered, brings the video in front of the previous item
     * so there's no black flash between items. Returns when it ends (or right after it starts when looping).
     */
    private suspend fun playMedia(media: MediaItem, untilEnded: Boolean, onStart: () -> Unit = {}) {
        val exo = ensureExo()
        val view = videoView!!
        suspendCancellableCoroutine<Unit> { cont ->
            lateinit var listener: Player.Listener
            // A decoder that silently draws nothing counts as a failure after a while.
            val watchdog = Runnable {
                exo.removeListener(listener)
                exo.stop()
                if (cont.isActive) cont.resumeWithException(NoPictureException())
            }
            listener = object : Player.Listener {
                override fun onRenderedFirstFrame() {
                    view.removeCallbacks(watchdog)
                    reveal(view)
                    onStart()
                    if (!untilEnded) finish(null)
                }

                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_ENDED) finish(null)
                }

                override fun onPlayerError(error: PlaybackException) = finish(error)

                fun finish(error: Throwable?) {
                    view.removeCallbacks(watchdog)
                    exo.removeListener(this)
                    if (!cont.isActive) return
                    if (error == null) cont.resume(Unit) else cont.resumeWithException(error)
                }
            }
            exo.addListener(listener)
            cont.invokeOnCancellation {
                view.post {
                    view.removeCallbacks(watchdog)
                    exo.removeListener(listener)
                }
            }
            view.postDelayed(watchdog, FIRST_FRAME_TIMEOUT_MS)
            exo.setMediaItem(media)
            exo.prepare()
            exo.playWhenReady = true
        }
    }

    // ---------- web pages and YouTube ----------

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureWeb(): WebView = webView ?: WebView(context).also { wv ->
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.mediaPlaybackRequiresUserGesture = false
        wv.settings.useWideViewPort = true
        wv.settings.loadWithOverviewMode = true
        wv.setBackgroundColor(Color.BLACK)
        wv.isFocusable = false
        wv.webChromeClient = WebChromeClient()
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                if (url != "about:blank") pageLoaded?.complete(Unit)
            }
        }
        wv.visibility = View.INVISIBLE
        webView = wv
        container.addView(wv, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    }

    private suspend fun showWeb(item: Item) {
        val wv = ensureWeb()
        val loaded = CompletableDeferred<Unit>()
        pageLoaded = loaded
        if (item.kind == "html") {
            wv.loadDataWithBaseURL(serverUrl.trimEnd('/') + "/", item.html.replace("__DEVICE_TOKEN__", deviceToken), "text/html", "utf-8", null)
        } else if (item.kind == "youtube") {
            // An embed inside a page of our own: YouTube refuses embeds loaded without a referring page.
            val mute = if (item.sound) 0 else 1
            val common = "autoplay=1&mute=$mute&controls=0&loop=1&playsinline=1&rel=0"
            val src = when {
                item.videoId.isNotEmpty() && item.listId.isNotEmpty() -> "https://www.youtube.com/embed/${item.videoId}?list=${item.listId}&$common"
                item.videoId.isNotEmpty() -> "https://www.youtube.com/embed/${item.videoId}?playlist=${item.videoId}&$common"
                item.channelId.isNotEmpty() -> "https://www.youtube.com/embed/live_stream?channel=${item.channelId}&$common"
                else -> "https://www.youtube.com/embed/videoseries?list=${item.listId}&$common"
            }
            val html = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
                "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>" +
                "</head><body><iframe src=\"$src\" allow=\"autoplay; encrypted-media\" allowfullscreen></iframe></body></html>"
            wv.loadDataWithBaseURL("https://${context.packageName}.player/", html, "text/html", "utf-8", null)
        } else {
            wv.loadUrl(item.url)
        }
        // Keep the previous item up while the page loads, but don't wait forever on a slow site.
        withTimeoutOrNull(8000) { loaded.await() }
        reveal(wv)
    }

    // ---------- text and tickers ----------

    private suspend fun showText(item: Item) {
        stopTicker()
        container.awaitLaidOut()
        textBox.setBackgroundColor(item.background)
        textView.setTextColor(item.color)
        textView.text = item.text
        textView.translationX = 0f
        val h = container.height
        if (item.scroll) {
            TextViewCompat.setAutoSizeTextTypeWithDefaults(textView, TextViewCompat.AUTO_SIZE_TEXT_TYPE_NONE)
            textView.isSingleLine = true
            textView.setPadding(0, 0, 0, 0)
            textView.setTextSize(TypedValue.COMPLEX_UNIT_PX, h * 0.55f)
            val textW = textView.paint.measureText(item.text).toInt() + h
            textView.layoutParams = FrameLayout.LayoutParams(textW, MATCH_PARENT)
            val from = container.width.toFloat()
            val to = -textW.toFloat()
            // A calm, broadcast-style pace: about 20 seconds to cross the zone, whatever the screen size.
            val pxPerSecond = maxOf(container.width / 20f, 50f)
            ticker = ValueAnimator.ofFloat(from, to).apply {
                duration = ((from - to) / pxPerSecond * 1000).toLong()
                repeatCount = ValueAnimator.INFINITE
                interpolator = LinearInterpolator()
                addUpdateListener { textView.translationX = it.animatedValue as Float }
                start()
            }
        } else {
            textView.isSingleLine = false
            textView.maxLines = Int.MAX_VALUE
            val pad = (minOf(container.width, h) * 0.06f).toInt()
            textView.setPadding(pad, pad, pad, pad)
            textView.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
            TextViewCompat.setAutoSizeTextTypeUniformWithConfiguration(textView, 8, 600, 2, TypedValue.COMPLEX_UNIT_SP)
        }
        reveal(textBox)
    }

    private fun stopTicker() {
        ticker?.cancel()
        ticker = null
    }

    // ---------- switching ----------

    /** Makes [view] the one on top. The video view stays underneath and shows through when nothing covers it. */
    private fun reveal(view: View?) {
        imageView.visibility = if (view == imageView) View.VISIBLE else View.INVISIBLE
        textBox.visibility = if (view == textBox) View.VISIBLE else View.INVISIBLE
        if (view != textBox) stopTicker()
        webView?.let { wv ->
            if (view != wv && wv.visibility == View.VISIBLE) wv.loadUrl("about:blank") // stops sound and scripts
            wv.visibility = if (view == wv) View.VISIBLE else View.INVISIBLE
        }
        if (view != videoView) exo?.stop()
    }

    private fun blank() = reveal(null)

    private suspend fun View.awaitLaidOut() {
        if (isLaidOut && width > 0 && height > 0) return
        suspendCancellableCoroutine { cont -> doOnLayout { if (cont.isActive) cont.resume(Unit) } }
    }

    private companion object {
        const val TAG = "PlaylistPlayer"
        const val FIRST_FRAME_TIMEOUT_MS = 15_000L
    }
}
