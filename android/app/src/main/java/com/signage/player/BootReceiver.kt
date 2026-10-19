package com.signage.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Opens the player when the device powers on or the app is updated.
 * On Android 10+ background activity starts are restricted; see the README for kiosk setup.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
