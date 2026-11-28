package com.familyscreenwarden.kids

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import kotlinx.serialization.Serializable
import com.familyscreenwarden.kids.core.AppMatch
import com.familyscreenwarden.kids.core.AppRule
import com.familyscreenwarden.kids.core.InstalledApp
import java.io.File

/** A launcher tile's look (the same shape the Windows app sends: the icon's address and its main color). */
@Serializable data class Tile(val launch: String? = null, val icon: String? = null, val color: String? = null, val found: Boolean = false)

/** The apps on the phone that open from a home screen, their icons, and which parent's rule each one is under. */
class Apps(context: Context) {
    private val ctx = context.applicationContext
    private val pm = ctx.packageManager
    val iconDir = File(ctx.cacheDir, "launcher/icons").apply { mkdirs() }
    private var scanned = 0L
    private var cache: List<InstalledApp> = emptyList()
    private val colors = HashMap<String, String?>()

    /** Apps with a home-screen icon (not this app). Cheap after the first call (rescanned when apps change). */
    fun installed(force: Boolean = false): List<InstalledApp> {
        if (!force && System.currentTimeMillis() - scanned < 5 * 60_000 && cache.isNotEmpty()) return cache
        val i = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        // Right after a restart, before the phone is unlocked, Android lists only a few apps unless asked for all of them
        // (that list was kept for 5 minutes: allowed apps went missing after a restart).
        val flags = PackageManager.MATCH_ALL or PackageManager.MATCH_DIRECT_BOOT_AWARE or PackageManager.MATCH_DIRECT_BOOT_UNAWARE
        cache = pm.queryIntentActivities(i, flags)
            .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
            .filter { it.first != ctx.packageName }
            .distinctBy { it.first }
            .map { InstalledApp(it.first, it.second) }
            .sortedBy { it.label.lowercase() }
        // Still locked: look again soon rather than keeping a list that may be short.
        val unlocked = ctx.getSystemService(android.os.UserManager::class.java).isUserUnlocked
        scanned = if (unlocked) System.currentTimeMillis() else System.currentTimeMillis() - 4 * 60_000
        return cache
    }

    fun invalidate() { scanned = 0 }

    fun label(pkg: String): String? = runCatching { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() }.getOrNull()

    /** Packages under each rule (a rule can cover several apps). */
    fun packagesByRule(rules: List<AppRule>): Map<String, List<String>> {
        val out = HashMap<String, MutableList<String>>()
        for (a in installed()) AppMatch.ruleFor(a, rules)?.let { out.getOrPut(it.key) { mutableListOf() } += a.pkg }
        return out
    }

    fun ruleOf(pkg: String, rules: List<AppRule>): AppRule? {
        val label = installed().firstOrNull { it.pkg == pkg }?.label ?: label(pkg) ?: return null
        return AppMatch.ruleFor(InstalledApp(pkg, label), rules)
    }

    /** Tiles for the allowed apps: the first matching app's icon (saved as a PNG the page loads from cache.screenwarden). */
    fun tiles(rules: List<AppRule>): Map<String, Tile> {
        val byRule = packagesByRule(rules)
        return rules.associate { r ->
            val pkg = byRule[r.key]?.firstOrNull()
            r.key to if (pkg == null) Tile(found = false) else Tile(launch = pkg, icon = icon(pkg), color = colors[pkg], found = true)
        }
    }

    fun launchIntent(pkg: String): Intent? = pm.getLaunchIntentForPackage(pkg)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun icon(pkg: String): String? {
        val f = File(iconDir, "$pkg.png")
        if (!f.exists() || System.currentTimeMillis() - f.lastModified() > 7 * 86400_000L) {
            val d = runCatching { pm.getApplicationIcon(pkg) }.getOrNull() ?: return null
            val b = bitmap(d, 128)
            f.outputStream().use { b.compress(Bitmap.CompressFormat.PNG, 100, it) }
            colors[pkg] = mainColor(b)
        } else if (!colors.containsKey(pkg)) {
            colors[pkg] = runCatching { mainColor(android.graphics.BitmapFactory.decodeFile(f.path)) }.getOrNull()
        }
        return "https://cache.screenwarden/icons/$pkg.png"
    }

    private fun bitmap(d: Drawable, size: Int): Bitmap {
        val b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(b)
        d.setBounds(0, 0, size, size)
        d.draw(c)
        return b
    }

    /** The icon's main color: the average of its colorful pixels (so the card matches the logo). */
    private fun mainColor(b: Bitmap): String? {
        var r = 0L; var g = 0L; var bl = 0L; var n = 0L
        val hsv = FloatArray(3)
        for (y in 0 until b.height step 4) for (x in 0 until b.width step 4) {
            val p = b.getPixel(x, y)
            if ((p ushr 24) < 200) continue
            android.graphics.Color.colorToHSV(p, hsv)
            if (hsv[1] < 0.25f || hsv[2] < 0.2f) continue
            r += (p shr 16) and 0xff; g += (p shr 8) and 0xff; bl += p and 0xff; n++
        }
        if (n == 0L) return null
        return "#%02x%02x%02x".format(r / n, g / n, bl / n)
    }
}
