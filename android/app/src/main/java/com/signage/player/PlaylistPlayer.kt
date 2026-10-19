package com.signage.player

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import android.view.View
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class PlayableItem(val item: ManifestItem, val file: File)

/** Loops a list of images and videos fullscreen. Images use an ImageView, videos use ExoPlayer. */
class PlaylistPlayer(
    private val context: Context,
    private val imageView: ImageView,
    private val playerView: PlayerView,
    private val emptyView: View,
) {
    private val exo: ExoPlayer = ExoPlayer.Builder(context).build().also { playerView.player = it }
    private var job: Job? = null

    /** Replaces whatever is playing and starts the new list from the top. */
    fun play(scope: CoroutineScope, items: List<PlayableItem>) {
        job?.cancel()
        job = scope.launch {
            try {
                loop(items)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.e(TAG, "Playback failed", e)
                emptyView.visibility = View.VISIBLE
            } finally {
                exo.stop()
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        exo.stop()
        imageView.visibility = View.INVISIBLE
        playerView.visibility = View.INVISIBLE
        emptyView.visibility = View.GONE
    }

    fun release() {
        stop()
        exo.release()
    }

    private suspend fun loop(items: List<PlayableItem>) {
        emptyView.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        if (items.isEmpty()) {
            imageView.visibility = View.INVISIBLE
            playerView.visibility = View.INVISIBLE
            awaitCancellation()
        }

        // A single item never needs to change: show it and wait.
        if (items.size == 1) {
            val only = items[0]
            if (only.item.isVideo) {
                exo.repeatMode = Player.REPEAT_MODE_ONE
                playVideo(only.file, untilEnded = false)
            } else {
                showImage(only.file)
            }
            awaitCancellation()
        }

        exo.repeatMode = Player.REPEAT_MODE_OFF
        // Every step suspends (delay or video playback), so cancellation always gets through.
        while (true) {
            for (p in items) {
                try {
                    if (p.item.isVideo) {
                        playVideo(p.file, untilEnded = true)
                    } else {
                        showImage(p.file)
                        delay(p.item.duration * 1000L)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Skip a broken file rather than stopping the whole screen.
                    Log.w(TAG, "Skipping ${p.file.name}", e)
                    delay(1000)
                }
            }
        }
    }

    private suspend fun showImage(file: File) {
        val bitmap = withContext(Dispatchers.IO) { decodeForScreen(file) }
            ?: throw IllegalStateException("Cannot decode ${file.name}")
        imageView.setImageBitmap(bitmap)
        imageView.visibility = View.VISIBLE
        playerView.visibility = View.INVISIBLE
        exo.stop()
    }

    /**
     * Starts the video and, once its first frame is rendered, swaps it in front of the previous image
     * so there's no black flash between items. Returns when it ends (or right after it starts when looping).
     */
    private suspend fun playVideo(file: File, untilEnded: Boolean) {
        suspendCancellableCoroutine<Unit> { cont ->
            val listener = object : Player.Listener {
                override fun onRenderedFirstFrame() {
                    playerView.visibility = View.VISIBLE
                    imageView.visibility = View.INVISIBLE
                    if (!untilEnded) finish(null)
                }

                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_ENDED) finish(null)
                }

                override fun onPlayerError(error: PlaybackException) = finish(error)

                fun finish(error: Throwable?) {
                    exo.removeListener(this)
                    if (!cont.isActive) return
                    if (error == null) cont.resume(Unit) else cont.resumeWithException(error)
                }
            }
            exo.addListener(listener)
            cont.invokeOnCancellation { playerView.post { exo.removeListener(listener) } }
            exo.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
            exo.prepare()
            exo.playWhenReady = true
        }
    }

    /** Decodes at roughly screen resolution so a 6000px photo doesn't run a TV box out of memory. */
    private fun decodeForScreen(file: File): Bitmap? {
        val metrics = context.resources.displayMetrics
        val targetW = maxOf(metrics.widthPixels, metrics.heightPixels)
        val targetH = minOf(metrics.widthPixels, metrics.heightPixels)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= targetW && bounds.outHeight / (sample * 2) >= targetH) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private companion object {
        const val TAG = "PlaylistPlayer"
    }
}
