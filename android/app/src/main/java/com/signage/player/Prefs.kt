package com.signage.player

import android.content.Context

/** Everything the player remembers across restarts. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("signage", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = sp.getString("serverUrl", null)
        set(v) = sp.edit().putString("serverUrl", v).apply()

    var deviceToken: String?
        get() = sp.getString("deviceToken", null)
        set(v) = sp.edit().putString("deviceToken", v).apply()

    var deviceName: String?
        get() = sp.getString("deviceName", null)
        set(v) = sp.edit().putString("deviceName", v).apply()

    /** Last manifest whose media is fully downloaded, so the screen can play offline after a reboot. */
    var manifestJson: String?
        get() = sp.getString("manifest", null)
        set(v) = sp.edit().putString("manifest", v).apply()

    /** How video is drawn on this device: "surface", or "texture" once SurfaceView showed no picture here. */
    var videoMode: String
        get() = sp.getString("videoMode", null) ?: VideoView.MODE_SURFACE
        set(v) = sp.edit().putString("videoMode", v).apply()

    fun unpair() {
        sp.edit().remove("deviceToken").remove("deviceName").remove("manifest").apply()
    }
}
