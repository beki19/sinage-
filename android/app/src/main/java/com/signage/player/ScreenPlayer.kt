package com.signage.player

import android.content.Context
import android.graphics.Color
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import kotlinx.coroutines.CoroutineScope
import java.io.File
import kotlin.math.roundToInt

/** Plays a [Program]: one [PlaylistPlayer] per zone, each in its own rectangle of [stage]. */
class ScreenPlayer(
    private val context: Context,
    private val stage: ZoneLayout,
    private val emptyView: View,
) {
    private var zones = emptyList<PlaylistPlayer>()

    fun play(scope: CoroutineScope, program: Program?, serverUrl: String, deviceToken: String, fileFor: (String) -> File?) {
        stop()
        val active = program?.zones.orEmpty().filter { it.items.isNotEmpty() && it.w > 0 && it.h > 0 }
        emptyView.visibility = if (active.isEmpty()) View.VISIBLE else View.GONE
        // Only the biggest zone plays sound, so two videos don't talk over each other.
        val loudest = active.maxByOrNull { it.w * it.h }
        zones = active.map { z ->
            val box = FrameLayout(context).apply { setBackgroundColor(Color.BLACK) }
            stage.addZone(box, RectF(z.x, z.y, z.x + z.w, z.y + z.h))
            PlaylistPlayer(context, box, withSound = z === loudest, serverUrl, deviceToken).also { it.play(scope, z.items, fileFor) }
        }
    }

    fun stop() {
        zones.forEach { it.release() }
        zones = emptyList()
        stage.removeAllViews()
        emptyView.visibility = View.GONE
    }

    fun release() = stop()
}

/** Lays out each child in a rectangle given in percent of this view's size. */
class ZoneLayout @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : ViewGroup(context, attrs) {
    private val rects = HashMap<View, RectF>()

    fun addZone(view: View, percentRect: RectF) {
        rects[view] = percentRect
        addView(view)
    }

    override fun onViewRemoved(child: View) {
        super.onViewRemoved(child)
        rects.remove(child)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = getDefaultSize(suggestedMinimumWidth, widthMeasureSpec)
        val h = getDefaultSize(suggestedMinimumHeight, heightMeasureSpec)
        setMeasuredDimension(w, h)
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            val b = bounds(child, w, h)
            child.measure(
                MeasureSpec.makeMeasureSpec(b[2] - b[0], MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(b[3] - b[1], MeasureSpec.EXACTLY),
            )
        }
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            val bb = bounds(child, r - l, b - t)
            child.layout(bb[0], bb[1], bb[2], bb[3])
        }
    }

    /** Rounds each edge separately so zones that touch in percent also touch in pixels. */
    private fun bounds(child: View, w: Int, h: Int): IntArray {
        val p = rects[child] ?: RectF(0f, 0f, 100f, 100f)
        return intArrayOf(
            (p.left * w / 100).roundToInt(), (p.top * h / 100).roundToInt(),
            (p.right * w / 100).roundToInt(), (p.bottom * h / 100).roundToInt(),
        )
    }
}
