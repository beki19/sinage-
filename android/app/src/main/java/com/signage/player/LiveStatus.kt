package com.signage.player

import android.content.Context
import kotlinx.coroutines.channels.Channel
import org.json.JSONArray
import org.json.JSONObject

/** What the player is doing, sent to the CMS so the Screens page can show it live. Touched only on the main thread. */
class LiveStatus {
    data class Zone(val itemId: String?, val kind: String?, val state: String, val error: String?)

    var state = "starting"
    var message: String? = null
    var program: String? = null
    /** done, total, bytes of the file being downloaded */
    var download: Triple<Int, Int, Long>? = null
    val zones = LinkedHashMap<String, Zone>()

    /** Wakes the sender; several changes in a row are sent as one. */
    val dirty = Channel<Unit>(Channel.CONFLATED)

    fun changed() {
        dirty.trySend(Unit)
    }

    fun toJson(context: Context, videoMode: String): String {
        val metrics = context.resources.displayMetrics
        val o = JSONObject()
            .put("state", if (zones.values.any { it.state == "error" }) "error" else state)
            .put("message", message)
            .put("program", program)
            .put("screen", "${metrics.widthPixels}×${metrics.heightPixels}")
            .put("freeMb", context.filesDir.usableSpace / 1_000_000)
            .put("videoMode", videoMode)
            .put("zones", JSONArray().apply {
                for ((id, z) in zones) {
                    put(JSONObject().put("zoneId", id).put("itemId", z.itemId).put("kind", z.kind).put("state", z.state).put("error", z.error))
                }
            })
        download?.let { (done, total, bytes) ->
            o.put("download", JSONObject().put("done", done).put("total", total).put("mb", bytes / 1_000_000))
        }
        return o.toString()
    }
}
