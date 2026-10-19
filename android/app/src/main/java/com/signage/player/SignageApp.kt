package com.signage.player

import android.app.Activity
import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle

/**
 * Many TVs don't reboot when switched off with the remote; they go to standby and wake up on their own home
 * screen or last input. While the app is running, this brings the player back to the front when the screen wakes.
 */
class SignageApp : Application() {
    private var playerVisible = false

    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) { if (activity is MainActivity) playerVisible = true }
            override fun onActivityPaused(activity: Activity) { if (activity is MainActivity) playerVisible = false }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        val wake = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                // Only for a paired screen, and only if something else is in front.
                if (playerVisible || Prefs(context).deviceToken == null) return
                runCatching { BootReceiver.open(context) }
            }
        }
        registerReceiver(wake, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        })
    }
}
