package com.signage.player

import android.graphics.Color
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

data class Registration(val code: String, val pollToken: String)

sealed class PairStatus {
    data class Pending(val code: String) : PairStatus()
    data class Paired(val deviceId: String, val deviceName: String, val deviceToken: String) : PairStatus()
    object Expired : PairStatus()
}

/** An uploaded image or video the player downloads and keeps on disk. */
data class MediaFile(
    val mediaId: String,
    val type: String,
    val mime: String,
    val size: Long,
    val sha256: String,
    val url: String,
)

/** One thing shown in a zone. [kind] is image, video, text, web, youtube or stream. */
data class Item(
    val id: String,
    val kind: String,
    /** Seconds on screen. Videos play to the end and ignore this. */
    val duration: Int,
    /** Optional show window in epoch millis, from local date-times in the CMS. */
    val startAt: Long?,
    val endAt: Long?,
    val mediaId: String? = null,
    val text: String = "",
    val color: Int = Color.WHITE,
    val background: Int = Color.BLACK,
    val scroll: Boolean = false,
    val url: String = "",
    val videoId: String = "",
) {
    fun isActiveAt(now: Long) = (startAt == null || now >= startAt) && (endAt == null || now < endAt)
}

/** A rectangle of the screen, in percent, looping its own items. */
data class Zone(val id: String, val x: Float, val y: Float, val w: Float, val h: Float, val items: List<Item>)

/** Everything that fills the screen at once: a playlist (one zone) or a layout (several). */
data class Program(val id: String, val name: String, val zones: List<Zone>)

/**
 * Shows [program] on [days] (0 = Sunday) from [start] to [end], in minutes after midnight on this device's clock.
 * An end at or before the start runs past midnight; equal start and end means all day. Mirrors ruleMatches in the CMS.
 */
data class ScheduleRule(val days: Set<Int>, val start: Int, val end: Int, val program: String) {
    fun matches(now: Calendar): Boolean {
        val t = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        val day = now.get(Calendar.DAY_OF_WEEK) - 1 // Calendar.SUNDAY is 1
        return when {
            start == end -> day in days
            start < end -> day in days && t >= start && t < end
            else -> (day in days && t >= start) || ((day + 6) % 7 in days && t < end)
        }
    }
}

data class Manifest(
    val deviceName: String,
    val version: String,
    val media: List<MediaFile>,
    val programs: Map<String, Program>,
    val defaultProgram: String?,
    val schedule: List<ScheduleRule>,
    val pollSeconds: Int,
) {
    /** The first matching time slot wins; otherwise the default. */
    fun activeProgram(now: Calendar = Calendar.getInstance()): Program? {
        val id = schedule.firstOrNull { it.program in programs && it.matches(now) }?.program ?: defaultProgram
        return id?.let { programs[it] }
    }

    companion object {
        fun parse(json: String): Manifest {
            val o = JSONObject(json)
            val mediaArr = o.optJSONArray("media")
            val programsArr = o.optJSONArray("programs")
            val media: List<MediaFile>
            val programs: List<Program>
            val defaultProgram: String?
            if (mediaArr != null && programsArr != null) {
                media = (0 until mediaArr.length()).map { parseMedia(mediaArr.getJSONObject(it)) }
                programs = (0 until programsArr.length()).map { parseProgram(programsArr.getJSONObject(it)) }
                defaultProgram = o.optString("defaultProgram").takeIf { it.isNotEmpty() && it != "null" }
            } else {
                // Older CMS: a flat list of images and videos.
                val arr = o.getJSONArray("items")
                val legacy = (0 until arr.length()).map { arr.getJSONObject(it) }
                media = legacy.map { parseMedia(it) }.distinctBy { it.mediaId }
                val items = legacy.map {
                    Item(it.getString("id"), it.getString("type"), it.optInt("duration", 10).coerceAtLeast(1), null, null, mediaId = it.getString("mediaId"))
                }
                programs = listOf(Program("legacy", "", listOf(Zone("main", 0f, 0f, 100f, 100f, items))))
                defaultProgram = "legacy"
            }
            return Manifest(
                deviceName = o.optString("deviceName"),
                version = o.getString("version"),
                media = media,
                programs = programs.associateBy { it.id },
                defaultProgram = defaultProgram,
                schedule = parseSchedule(o),
                pollSeconds = o.optInt("pollSeconds", 30).coerceIn(5, 3600),
            )
        }

        private fun parseSchedule(o: JSONObject): List<ScheduleRule> {
            val arr = o.optJSONArray("schedule") ?: return emptyList()
            fun minutes(s: String) = s.split(":").let { it[0].toInt() * 60 + it[1].toInt() }
            return (0 until arr.length()).mapNotNull { i ->
                runCatching {
                    val r = arr.getJSONObject(i)
                    val days = r.getJSONArray("days")
                    ScheduleRule(
                        days = (0 until days.length()).map { days.getInt(it) }.toSet(),
                        start = minutes(r.getString("start")),
                        end = minutes(r.getString("end")),
                        program = r.getString("program"),
                    )
                }.getOrNull()
            }
        }

        private fun parseMedia(m: JSONObject) = MediaFile(
            mediaId = m.getString("mediaId"),
            type = m.getString("type"),
            mime = m.optString("mime"),
            size = m.optLong("size"),
            sha256 = m.getString("sha256"),
            url = m.getString("url"),
        )

        private fun parseProgram(p: JSONObject): Program {
            val zones = p.getJSONArray("zones")
            return Program(p.getString("id"), p.optString("name"), (0 until zones.length()).map { i ->
                val z = zones.getJSONObject(i)
                val items = z.getJSONArray("items")
                Zone(
                    id = z.optString("id", "zone$i"),
                    x = z.optDouble("x", 0.0).toFloat(),
                    y = z.optDouble("y", 0.0).toFloat(),
                    w = z.optDouble("w", 100.0).toFloat(),
                    h = z.optDouble("h", 100.0).toFloat(),
                    items = (0 until items.length()).mapNotNull { parseItem(items.getJSONObject(it)) },
                )
            })
        }

        private fun parseItem(it: JSONObject): Item? {
            val kind = it.getString("kind")
            if (kind !in KNOWN_KINDS) return null // Newer CMS feature this app doesn't know yet: skip it.
            return Item(
                id = it.getString("id"),
                kind = kind,
                duration = it.optInt("duration", 10).coerceAtLeast(1),
                startAt = localTime(it.optString("startAt")),
                endAt = localTime(it.optString("endAt")),
                mediaId = it.optString("mediaId").takeIf { s -> s.isNotEmpty() },
                text = it.optString("text"),
                color = parseColor(it.optString("color"), Color.WHITE),
                background = parseColor(it.optString("background"), Color.BLACK),
                scroll = it.optBoolean("scroll"),
                url = it.optString("url"),
                videoId = it.optString("videoId"),
            )
        }

        private val KNOWN_KINDS = setOf("image", "video", "text", "web", "youtube", "stream")

        /** "2026-10-19T08:00" in this device's time zone. */
        private fun localTime(s: String): Long? {
            if (s.isEmpty() || s == "null") return null
            return runCatching { SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.US).parse(s)?.time }.getOrNull()
        }

        private fun parseColor(s: String, fallback: Int) = runCatching { Color.parseColor(s) }.getOrDefault(fallback)
    }
}

/** The CMS no longer recognises this device (it was removed), so the player must pair again. */
class UnpairedException : Exception("Device is not paired")
