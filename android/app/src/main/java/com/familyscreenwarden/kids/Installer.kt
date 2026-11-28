package com.familyscreenwarden.kids

import androidx.core.app.NotificationCompat
import android.provider.Settings
import android.net.Uri
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.PowerManager
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import com.familyscreenwarden.kids.core.ApkInstall
import com.familyscreenwarden.kids.core.UpdateInfo
import java.io.File

/**
 * Installs APKs a parent pushed from the server, and updates this app (when the phone isn't being used). As the device
 * owner it installs without asking. One at a time; each one is checked against the SHA-256 the server gave.
 */
class Installer(context: Context) {
    private val ctx = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val dir = File(ctx.cacheDir, "apks").apply { mkdirs() }
    private val pending = ArrayDeque<ApkInstall>()
    private val done = mutableSetOf<String>()
    private val ours = mutableSetOf<String>()
    @Volatile var busy = false; private set
    private var update: UpdateInfo? = null
    private var updateBusy = false
    /** A newer version of this app is waiting to install (shown in the grown-up menu). */
    val waiting: String? get() = update?.takeIf { newer(it.version, Kids.version) }?.version

    fun isOurs(pkg: String) = pkg in ours

    fun queue(list: List<ApkInstall>) {
        synchronized(pending) { for (a in list) if (a.id !in done && pending.none { it.id == a.id }) pending.addLast(a) }
        next()
    }

    fun offerUpdate(u: UpdateInfo?) { update = u }

    private val asked = mutableSetOf<String>()

    /**
     * Every 15 seconds: install the next APK, or the app's update. The device owner updates by itself while the screen
     * is off. A phone that isn't (quick install) has to ask the person, so it asks once per version, while the screen is
     * on (Android shows "Update this app?"), and leaves a notification to tap.
     */
    fun upkeep() {
        next()
        val u = update ?: return
        if (!newer(u.version, Kids.version) || updateBusy || busy) return
        val on = ctx.getSystemService(PowerManager::class.java).isInteractive
        if (Kids.policy.isOwner) { if (!on) selfUpdate(u) }
        else if (on && asked.add(u.version)) startUpdate(u)
    }

    fun updateNow(): String {
        val u = update
        if (u == null || !newer(u.version, Kids.version)) return "You have the newest version (${Kids.version})."
        // A try that's waiting on the person doesn't block a new one.
        if (updateBusy) { updateBusy = false; busy = false }
        return startUpdate(u)
    }

    private fun startUpdate(u: UpdateInfo): String {
        if (!Kids.policy.isOwner && !ctx.packageManager.canRequestPackageInstalls()) {
            val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ask(i, "Allow Family Screen Warden to update itself", "Tap, switch on “Allow from this source”, then tap Check for updates again.", 91)
            runCatching { ctx.startActivity(i) }
            return "Switch on “Allow from this source” for Family Screen Warden, then tap Check for updates again."
        }
        selfUpdate(u)
        return "Installing ${u.version} now."
    }

    /** Android needs the person to say yes (not the device owner): try now, and leave a notification to tap. */
    fun needsPerson(confirm: Intent, id: String?, label: String?) {
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (id == null) { updateBusy = false; ask(confirm, "Update Family Screen Warden", "Tap to install the new version.", 92) }
        else { done += id; ask(confirm, "Install ${label ?: "an app"}", "A grown-up sent it from the parent console. Tap to install.", 93) }
        runCatching { ctx.startActivity(confirm) }
        busy = false
        Kids.reapply()
        next()
    }

    private fun ask(i: Intent, title: String, text: String, nid: Int) {
        val pi = PendingIntent.getActivity(ctx, nid, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(ctx, "kids").setSmallIcon(R.drawable.ic_notify).setContentTitle(title).setContentText(text)
            .setContentIntent(pi).setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH).build()
        runCatching { ctx.getSystemService(NotificationManager::class.java).notify(nid, n) }
    }

    private fun next() {
        if (busy) return
        val a = synchronized(pending) { pending.removeFirstOrNull() } ?: return
        busy = true
        Kids.reapply()
        scope.launch {
            Kids.noteInstall(a.id, "installing", null)
            val f = File(dir, "${a.id}.apk")
            try {
                Kids.api!!.download(a.url, f, a.sha256)
                val info = ctx.packageManager.getPackageArchiveInfo(f.path, 0)
                val pkg = info?.packageName ?: throw Exception("That file isn't an Android app.")
                val label = info.applicationInfo?.let { it.sourceDir = f.path; it.publicSourceDir = f.path; ctx.packageManager.getApplicationLabel(it).toString() } ?: a.name
                ours += pkg
                install(f, a.id, pkg, label)
            } catch (e: Exception) {
                Log.w(Kids.TAG, "install ${a.name}: ${e.message}")
                Kids.noteInstall(a.id, "failed", e.message ?: "Didn't install")
                done += a.id
                finish()
            }
        }
    }

    private fun selfUpdate(u: UpdateInfo) {
        updateBusy = true
        busy = true
        Kids.reapply()
        scope.launch {
            val f = File(dir, "self-${u.version}.apk")
            try {
                Kids.api!!.download(u.url, f, u.sha256)
                install(f, null, ctx.packageName, "Family Screen Warden")
            } catch (e: Exception) {
                Log.w(Kids.TAG, "update: ${e.message}")
                updateBusy = false
                finish()
            }
        }
    }

    private fun install(f: File, id: String?, pkg: String, label: String) {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(pkg)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sid = pi.createSession(params)
        pi.openSession(sid).use { s ->
            s.openWrite("app.apk", 0, f.length()).use { out -> f.inputStream().use { it.copyTo(out) }; s.fsync(out) }
            val i = Intent(ctx, InstallReceiver::class.java).putExtra("id", id).putExtra("pkg", pkg).putExtra("label", label).putExtra("file", f.path)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            s.commit(PendingIntent.getBroadcast(ctx, sid, i, flags).intentSender)
        }
    }

    fun result(id: String?, pkg: String?, label: String?, file: String?, status: Int, message: String?) {
        file?.let { File(it).delete() }
        if (id != null) {
            done += id
            if (status == PackageInstaller.STATUS_SUCCESS) Kids.noteInstall(id, "done", null, pkg, label)
            else Kids.noteInstall(id, "failed", message ?: "Didn't install")
        } else updateBusy = false
        finish()
    }

    private fun finish() { busy = false; Kids.reapply(); next() }

    companion object {
        fun newer(a: String, b: String): Boolean {
            val x = a.split('.').map { it.toIntOrNull() ?: 0 }
            val y = b.split('.').map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(x.size, y.size)) { val p = x.getOrElse(i) { 0 }; val q = y.getOrElse(i) { 0 }; if (p != q) return p > q }
            return false
        }
    }
}

class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Kids.init(context)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Not the device owner (a quick-install phone): Android asks the person. On newer Android an app in the
            // background can't open that screen by itself, so there's a notification to tap too.
            @Suppress("DEPRECATION") val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
            Kids.installer.needsPerson(confirm, intent.getStringExtra("id"), intent.getStringExtra("label"))
            return
        }
        Kids.installer.result(intent.getStringExtra("id"), intent.getStringExtra("pkg"), intent.getStringExtra("label"), intent.getStringExtra("file"), status,
            intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
    }
}
