package com.familyscreenwarden.kids

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/** Keeps the screen-time clock and the server check-ins running (a small, silent notification while it does). */
class KidsService : Service() {
    companion object {
        fun start(ctx: Context) {
            runCatching { ctx.startForegroundService(Intent(ctx, KidsService::class.java)) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Kids.init(this)
        val open = PendingIntent.getActivity(this, 0, Intent(this, LauncherActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, "service").setSmallIcon(R.drawable.ic_notify).setContentTitle("Family Screen Warden")
            .setContentText("Screen time is on").setOngoing(true).setContentIntent(open).setPriority(NotificationCompat.PRIORITY_MIN).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(1, n)
        Kids.start()
        if (Kids.paired) SafeVpn.start(this)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null
}

/** After a restart or an update of this app: start again. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Kids.init(context)
        KidsService.start(context)
        // BOOT_COMPLETED comes once the phone is unlocked: everything can be read now.
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_USER_UNLOCKED) Kids.unlocked()
    }
}

/** An app was installed or removed: the launcher's list changes (and Play Store installs a grown-up allowed are noted). */
class PackageReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Kids.init(context)
        val pkg = intent.data?.schemeSpecificPart ?: return
        if (intent.action == Intent.ACTION_PACKAGE_ADDED && !intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) Kids.notePackageAdded(pkg)
        else Kids.apps.invalidate()
    }
}
