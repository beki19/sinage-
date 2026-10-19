package com.signage.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper

/**
 * Opens the player when the device powers on or the app is updated. TV makers use different "boot finished"
 * signals, so it listens for several. It also tries again a little later, because many TVs bring up their own
 * home screen or last TV input after boot, covering the player.
 * On Android 10+ this needs the "draw over other apps" permission, which the app asks for once.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in ACTIONS) return
        val app = context.applicationContext
        val pending = goAsync()
        val handler = Handler(Looper.getMainLooper())
        for ((i, wait) in RETRY_MS.withIndex()) {
            handler.postDelayed({
                runCatching { open(app) }
                if (i == RETRY_MS.lastIndex) pending.finish()
            }, wait)
        }
    }

    companion object {
        private val ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.LOCKED_BOOT_COMPLETED",
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
            Intent.ACTION_MY_PACKAGE_REPLACED,
        )

        /** Opens now, then brings the player back to the front twice more in case the TV's own home screen covered it. */
        private val RETRY_MS = longArrayOf(0, 8_000, 20_000)

        fun open(context: Context) {
            context.startActivity(
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
            )
        }
    }
}
