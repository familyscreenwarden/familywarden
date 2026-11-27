package com.familyscreenwarden.kids

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.os.UserManager
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.telecom.InCallService
import android.telecom.TelecomManager
import android.util.Log
import com.familyscreenwarden.kids.admin.KidsAdminReceiver
import com.familyscreenwarden.kids.core.PhoneRules
import com.familyscreenwarden.kids.core.SafeSearchInfo

/**
 * Everything the app does as the phone's device owner. Each call is safe to repeat; nothing here throws (a phone that
 * isn't set up as device owner just doesn't get the lock-downs, and the setup screen says so).
 */
class Policy(context: Context) {
    private val ctx = context.applicationContext
    private val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
    val admin = ComponentName(ctx, KidsAdminReceiver::class.java)

    val isOwner: Boolean get() = dpm.isDeviceOwnerApp(ctx.packageName)

    private inline fun owner(what: String, f: () -> Unit) {
        if (!isOwner) return
        try { f() } catch (e: Exception) { Log.w("ScreenWarden", "$what: ${e.message}") }
    }

    /** Things set once: this app is the home screen, can't be removed, keeps its permissions, and starts after updates. */
    fun base() = owner("base") {
        val home = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) }
        dpm.addPersistentPreferredActivity(admin, home, ComponentName(ctx, LauncherActivity::class.java))
        dpm.setUninstallBlocked(admin, ctx.packageName, true)
        for (p in listOf(Manifest.permission.CALL_PHONE, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG, Manifest.permission.ANSWER_PHONE_CALLS, Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS) + (if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()))
            dpm.setPermissionGrantState(admin, ctx.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
        // Family Screen Warden is the phone's call app: its call screen with family names (Android 14+; older phones ask at setup).
        if (Build.VERSION.SDK_INT >= 34) runCatching { dpm.setDefaultDialerApplication(ctx.packageName) }
        // What Google Play and Google's services need: the clock and time zone set by the network, location on.
        if (Build.VERSION.SDK_INT >= 30) {
            runCatching { dpm.setAutoTimeEnabled(admin, true) }
            runCatching { dpm.setAutoTimeZoneEnabled(admin, true) }
            runCatching { dpm.setLocationEnabled(admin, true) }
        }
        // Private DNS (encrypted DNS in Android's settings) would skip the safe-browsing filter.
        if (Build.VERSION.SDK_INT >= 29) dpm.setGlobalPrivateDnsModeOpportunistic(admin)
        dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_HOME or DevicePolicyManager.LOCK_TASK_FEATURE_OVERVIEW or
            DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS or DevicePolicyManager.LOCK_TASK_FEATURE_NOTIFICATIONS or
            DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO or DevicePolicyManager.LOCK_TASK_FEATURE_KEYGUARD)
        // Until the first answer from the server: this app and the phone app (so the launcher can lock in without asking).
        if (dpm.getLockTaskPackages(admin).isEmpty()) dpm.setLockTaskPackages(admin, (phonePackages() + ctx.packageName).distinct().toTypedArray())
    }

    /** The lock-downs from Family Screen Warden. [settingsOpen]: a grown-up opened the phone's settings for a while. */
    fun restrictions(r: PhoneRules, settingsOpen: Boolean, playOpen: Boolean, accountsOpen: Boolean = false) = owner("restrictions") {
        fun set(key: String, on: Boolean) = if (on) dpm.addUserRestriction(admin, key) else dpm.clearUserRestriction(admin, key)
        set(UserManager.DISALLOW_FACTORY_RESET, r.blockReset)
        set(UserManager.DISALLOW_SAFE_BOOT, r.blockSafeBoot)
        set(UserManager.DISALLOW_ADD_USER, true)
        set(UserManager.DISALLOW_DEBUGGING_FEATURES, r.blockUsb && !settingsOpen)
        set(UserManager.DISALLOW_USB_FILE_TRANSFER, r.blockUsb && !settingsOpen)
        set(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES, r.blockInstalls)
        if (Build.VERSION.SDK_INT >= 29) set(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY, r.blockInstalls)
        // The Play Store works only while a grown-up opened it.
        set(UserManager.DISALLOW_INSTALL_APPS, r.blockInstalls && !playOpen)
        set(UserManager.DISALLOW_UNINSTALL_APPS, r.blockInstalls && !settingsOpen)
        // Adding a Google account (needed once for the Play Store) and the rest: only while a grown-up opened settings.
        // A grown-up's Play Store window can add the Google account too (the Play Store asks for one the first time).
        set(UserManager.DISALLOW_MODIFY_ACCOUNTS, r.blockAccounts && !settingsOpen && !accountsOpen)
        set(UserManager.DISALLOW_CONFIG_DATE_TIME, r.blockSettings && !settingsOpen)
        set(UserManager.DISALLOW_APPS_CONTROL, r.blockSettings && !settingsOpen)
        set(UserManager.DISALLOW_CONFIG_VPN, true)
        if (Build.VERSION.SDK_INT >= 29) set(UserManager.DISALLOW_CONFIG_PRIVATE_DNS, true)
    }

    /** Only these apps can open (plus this app). Removing one from the list closes it right away. */
    fun allowOnly(packages: Collection<String>) = owner("lock task") {
        val list = (packages + ctx.packageName).distinct().toTypedArray()
        if (!dpm.getLockTaskPackages(admin).toSet().equals(list.toSet())) dpm.setLockTaskPackages(admin, list)
    }

    private var phonePkgs: List<String> = emptyList()
    private var phonePkgsAt = 0L

    /**
     * Everything a phone call needs to show its screen, so calls can be answered and hung up in lock-task mode:
     * the phone app, telecom, the emergency dialer, and every app that draws the in-call screen. On many phones
     * that's a separate app from the dialer (Samsung: com.samsung.android.incallui), found by its InCallService.
     */
    fun phonePackages(): List<String> {
        if (phonePkgs.isNotEmpty() && System.currentTimeMillis() - phonePkgsAt < 10 * 60_000) return phonePkgs
        val pm = ctx.packageManager
        val out = mutableListOf("com.android.phone", "com.android.server.telecom", "com.android.emergency")
        // Family Screen Warden is the phone app: its own call screen is the only one, and the phone's dialer stays closed
        // (so it can't be used to call anyone the family didn't list).
        if (Calls.isPhoneApp(ctx)) { phonePkgs = out; phonePkgsAt = System.currentTimeMillis(); return out }
        runCatching { ctx.getSystemService(TelecomManager::class.java).defaultDialerPackage }.getOrNull()?.let { out += it }
        // Apps with the system's in-call screen (only the system can bind these, so they're the phone's own).
        runCatching {
            pm.queryIntentServices(Intent(InCallService.SERVICE_INTERFACE), PackageManager.MATCH_ALL)
                .filter { it.serviceInfo.permission == Manifest.permission.BIND_INCALL_SERVICE && it.serviceInfo.applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM != 0 }
                .forEach { out += it.serviceInfo.packageName }
        }
        // Known call screens, when they're on the phone.
        for (p in listOf("com.samsung.android.incallui", "com.samsung.android.dialer", "com.android.incallui", "com.google.android.dialer", "com.android.dialer"))
            if (runCatching { pm.getPackageInfo(p, 0) }.isSuccess) out += p
        phonePkgs = out.filter { it != ctx.packageName }.distinct()
        phonePkgsAt = System.currentTimeMillis()
        return phonePkgs
    }

    /**
     * Google's own screens other apps open: Google sign-in and Play services dialogs (com.google.android.gms),
     * Android's permission prompts (an app asking for the camera), and the Play Store's helpers. Allowed whenever the
     * phone isn't locked, so apps that use Google work.
     */
    fun googlePackages(): List<String> = listOf(
        "com.google.android.gms", "com.google.android.gsf", "com.google.android.permissioncontroller", "com.android.permissioncontroller",
        "com.google.android.gms.policy_sidecar_aps", "com.google.android.apps.restore", "com.google.android.ext.services",
    ).filter { p -> runCatching { ctx.packageManager.getPackageInfo(p, 0) }.isSuccess }

    /** While a grown-up has the Play Store open: the store and Android's installer. */
    fun playPackages(): List<String> = listOf("com.android.vending", "com.google.android.packageinstaller", "com.android.packageinstaller")

    fun suspend(packages: Collection<String>, on: Boolean): List<String> {
        if (!isOwner || packages.isEmpty()) return emptyList()
        return try { dpm.setPackagesSuspended(admin, packages.toTypedArray(), on).toList() } catch (e: Exception) { Log.w("ScreenWarden", "suspend: ${e.message}"); emptyList() }
    }

    /**
     * The safe-browsing filter as Android's always-on VPN, started by Android itself (the kid can't turn it off: VPN
     * settings are locked). Not "block connections without VPN": the VPN only carries DNS, and that mode would cut
     * everything else off.
     */
    fun alwaysOnVpn(on: Boolean) = owner("vpn") {
        if (on && dpm.getAlwaysOnVpnPackage(admin) == ctx.packageName) return@owner
        dpm.setAlwaysOnVpnPackage(admin, if (on) ctx.packageName else null, false)
    }

    /** Chrome (if a grown-up allows it): only the websites the server allows, SafeSearch and YouTube's Restricted Mode. */
    fun chrome(hosts: List<String>, s: SafeSearchInfo) = owner("chrome") {
        val list = { l: List<String> -> l.joinToString(",", "[", "]") { "\"" + it.replace("\"", "") + "\"" } }
        val b = Bundle().apply {
            putString("URLBlocklist", list(listOf("*")))
            putString("URLAllowlist", list(hosts + listOf("chrome://policy")))
            putBoolean("ForceGoogleSafeSearch", s.search)
            putInt("ForceYouTubeRestrict", if (s.youTube) 1 else 0)
            putInt("IncognitoModeAvailability", 1)
            putString("DnsOverHttpsMode", "off")
            putBoolean("BrowserAddPersonEnabled", false)
        }
        dpm.setApplicationRestrictions(admin, "com.android.chrome", b)
    }

    fun lockNow() = owner("lock") { dpm.lockNow() }
    fun reboot() = owner("reboot") { dpm.reboot(admin) }
}
