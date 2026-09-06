package com.nightcode.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Foreground service that runs only while an HTTP stream / SSH request is in
 * flight. A backgrounded app is a candidate for the cached-app freezer; a
 * foreground service takes the process out of cached state, so streams keep
 * running with the app minimized. (A plain partial wake lock proved NOT to be
 * enough: the freezer still froze the process and killed the in-flight TCP
 * socket mid-stream.)
 *
 * The service is started/stopped by MainActivity.beginRequest()/endRequest()
 * via the static start/stop helpers; it never runs on its own.
 */
class StreamKeeperService : Service() {

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.stream_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.stream_channel_desc)
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.stream_notification_title))
            .setContentText(getString(R.string.stream_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(
                android.app.PendingIntent.getActivity(
                    this, 0,
                    Intent(this, MainActivity::class.java),
                    android.app.PendingIntent.FLAG_IMMUTABLE
                )
            )
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val CHANNEL_ID = "nightcode_stream"
        const val NOTIFICATION_ID = 1001
        const val ACTION_STOP = "com.nightcode.app.STREAM_STOP"
    }
}
