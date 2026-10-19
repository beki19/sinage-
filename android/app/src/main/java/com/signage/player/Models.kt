package com.signage.player

import org.json.JSONObject

data class Registration(val code: String, val pollToken: String)

sealed class PairStatus {
    data class Pending(val code: String) : PairStatus()
    data class Paired(val deviceId: String, val deviceName: String, val deviceToken: String) : PairStatus()
    object Expired : PairStatus()
}

data class ManifestItem(
    val id: String,
    val mediaId: String,
    val type: String,
    val mime: String,
    val size: Long,
    val sha256: String,
    /** Seconds an image stays on screen. Videos play to the end. */
    val duration: Int,
    val url: String,
) {
    val isVideo get() = type == "video"
}

data class Manifest(
    val deviceName: String,
    val version: String,
    val items: List<ManifestItem>,
    val pollSeconds: Int,
) {
    companion object {
        fun parse(json: String): Manifest {
            val o = JSONObject(json)
            val arr = o.getJSONArray("items")
            val items = (0 until arr.length()).map { i ->
                val it = arr.getJSONObject(i)
                ManifestItem(
                    id = it.getString("id"),
                    mediaId = it.getString("mediaId"),
                    type = it.getString("type"),
                    mime = it.optString("mime"),
                    size = it.optLong("size"),
                    sha256 = it.getString("sha256"),
                    duration = it.optInt("duration", 10).coerceAtLeast(1),
                    url = it.getString("url"),
                )
            }
            return Manifest(
                deviceName = o.optString("deviceName"),
                version = o.getString("version"),
                items = items,
                pollSeconds = o.optInt("pollSeconds", 30).coerceIn(5, 3600),
            )
        }
    }
}

/** The CMS no longer recognises this device (it was removed), so the player must pair again. */
class UnpairedException : Exception("Device is not paired")
