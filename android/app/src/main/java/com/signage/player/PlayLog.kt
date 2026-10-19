package com.signage.player

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Proof of play: counts showings and seconds on screen per item per hour, kept on the device until the
 * CMS has them (so offline time still counts). Saved to disk, so a restart doesn't lose unsent counts.
 * Touched only on the main thread.
 */
class PlayLog(context: Context) {
    private val sp = context.getSharedPreferences("playlog", Context.MODE_PRIVATE)

    private data class Key(val itemId: String, val kind: String, val mediaId: String?, val hour: Long)
    private class Count(var plays: Int, var seconds: Int)

    private val counts = LinkedHashMap<Key, Count>()

    init {
        runCatching { fromJson(JSONArray(sp.getString("pending", "[]"))) }
    }

    fun add(item: Item, seconds: Int, plays: Int) {
        val hour = System.currentTimeMillis() / HOUR_MS * HOUR_MS
        val c = counts.getOrPut(Key(item.id, item.kind, item.mediaId, hour)) { Count(0, 0) }
        c.plays += plays
        c.seconds += seconds
        // Keep at most a few weeks of hourly rows if the CMS stays out of reach.
        while (counts.size > MAX_ROWS) counts.remove(counts.keys.first())
        save()
    }

    /** Sends everything counted so far; on failure it all stays for the next try. */
    suspend fun flush(send: suspend (String) -> Unit) {
        if (counts.isEmpty()) return
        val sending = LinkedHashMap(counts)
        send(JSONObject().put("plays", toJson(sending)).toString())
        // Only drop what was sent: counts added while sending stay.
        for ((k, sent) in sending) {
            val now = counts[k] ?: continue
            now.plays -= sent.plays
            now.seconds -= sent.seconds
            if (now.plays <= 0 && now.seconds <= 0) counts.remove(k)
        }
        save()
    }

    private fun save() {
        sp.edit().putString("pending", toJson(counts).toString()).apply()
    }

    private fun toJson(map: Map<Key, Count>) = JSONArray().apply {
        for ((k, c) in map) {
            put(JSONObject().put("itemId", k.itemId).put("kind", k.kind).put("mediaId", k.mediaId)
                .put("at", k.hour).put("plays", c.plays).put("seconds", c.seconds))
        }
    }

    private fun fromJson(arr: JSONArray) {
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val k = Key(o.getString("itemId"), o.optString("kind"), o.optString("mediaId").takeIf { it.isNotEmpty() && it != "null" }, o.getLong("at"))
            counts[k] = Count(o.optInt("plays"), o.optInt("seconds"))
        }
    }

    private companion object {
        const val HOUR_MS = 3_600_000L
        const val MAX_ROWS = 5000
    }
}
