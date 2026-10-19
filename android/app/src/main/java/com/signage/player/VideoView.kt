package com.signage.player

import android.content.Context
import android.graphics.Color
import android.media.MediaCodecList
import android.view.Gravity
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout

/**
 * Where video is drawn: a SurfaceView (best on most devices) or a TextureView (works on some TVs whose
 * video overlay stays black). Keeps the picture's shape, centred, with black bars.
 */
@OptIn(UnstableApi::class)
class VideoView(context: Context, private val exo: ExoPlayer, val mode: String) : FrameLayout(context) {
    private val frame = AspectRatioFrameLayout(context).apply { resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT }
    private val surface: View = if (mode == MODE_TEXTURE) TextureView(context) else SurfaceView(context)
    private val listener = object : Player.Listener {
        override fun onVideoSizeChanged(size: VideoSize) {
            if (size.width > 0 && size.height > 0) frame.setAspectRatio(size.width * size.pixelWidthHeightRatio / size.height)
        }
    }

    init {
        setBackgroundColor(Color.BLACK)
        frame.addView(surface, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(frame, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT, Gravity.CENTER))
        when (surface) {
            is TextureView -> exo.setVideoTextureView(surface)
            is SurfaceView -> exo.setVideoSurfaceView(surface)
        }
        exo.addListener(listener)
    }

    /** Detaches from the player before this view is thrown away. */
    fun release() {
        exo.removeListener(listener)
        when (surface) {
            is TextureView -> exo.clearVideoTextureView(surface)
            is SurfaceView -> exo.clearVideoSurfaceView(surface)
        }
    }

    companion object {
        const val MODE_SURFACE = "surface"
        const val MODE_TEXTURE = "texture"
    }
}

/** Asks the device's decoders whether a video can be played, to explain a black screen in plain words. */
object VideoSupport {
    private val NAMES = mapOf(
        "avc1" to ("video/avc" to "H.264"), "avc3" to ("video/avc" to "H.264"),
        "hvc1" to ("video/hevc" to "H.265"), "hev1" to ("video/hevc" to "H.265"),
        "av01" to ("video/av01" to "AV1"), "vp09" to ("video/x-vnd.on2.vp9" to "VP9"), "vp08" to ("video/x-vnd.on2.vp8" to "VP8"),
    )

    /** null if the device says it can, otherwise why not. Unknown codecs or sizes give null. */
    fun problem(codec: String, width: Int, height: Int): String? {
        val (mime, name) = NAMES[codec] ?: return null
        if (width <= 0 || height <= 0) return null
        val decoders = runCatching {
            MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos.filter { !it.isEncoder && it.supportedTypes.any { t -> t.equals(mime, true) } }
        }.getOrDefault(emptyList())
        if (decoders.isEmpty()) return "This screen can't play $name video"
        val fits = decoders.any { info ->
            runCatching {
                val caps = info.getCapabilitiesForType(mime).videoCapabilities
                caps.isSizeSupported(width, height) || caps.isSizeSupported(height, width)
            }.getOrDefault(false)
        }
        return if (fits) null else "This screen can't play ${width}×${height} $name video. Use 1920×1080 or smaller."
    }
}
