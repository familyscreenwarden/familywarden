package com.familyscreenwarden.kids

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

    /** Every 15 seconds: install the next APK, or the app's update when the screen is off. */
    fun upkeep() {
        next()
        val u = update ?: return
        if (!newer(u.version, Kids.version) || updateBusy || busy) return
        if (ctx.getSystemService(PowerManager::class.java).isInteractive) return
        selfUpdate(u)
    }

    fun updateNow(): String {
        val u = update
        if (u == null || !newer(u.version, Kids.version)) return "You have the newest version (${Kids.version})."
        selfUpdate(u)
        return "Installing ${u.version} now."
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
            // Not the device owner (a test phone): Android asks the person.
            @Suppress("DEPRECATION") (intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT))?.let { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            return
        }
        Kids.installer.result(intent.getStringExtra("id"), intent.getStringExtra("pkg"), intent.getStringExtra("label"), intent.getStringExtra("file"), status,
            intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
    }
}
