package com.familyscreenwarden.kids

import android.app.ActivityManager
import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.telephony.SmsManager
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import com.familyscreenwarden.kids.core.Engine
import com.familyscreenwarden.kids.core.LauncherSettings
import com.familyscreenwarden.kids.core.PhoneRules
import com.familyscreenwarden.kids.core.RequestResult
import com.familyscreenwarden.kids.core.Snapshot
import com.familyscreenwarden.kids.core.Sites
import com.familyscreenwarden.kids.core.StatusDto
import com.familyscreenwarden.kids.core.UnlockCodes
import com.familyscreenwarden.kids.core.json
import java.time.LocalTime
import java.util.UUID

/**
 * The kid's phone: counts their time, applies their rules, talks to the server (through [WardenApi]), and answers the launcher page.
 * (KidsService keeps it running.)
 */
object Kids {
    const val TAG = "ScreenWarden"

    lateinit var ctx: Context; private set
    lateinit var store: Store; private set
    lateinit var policy: Policy; private set
    lateinit var apps: Apps; private set
    val installer by lazy { Installer(ctx) }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val gate = Mutex()
    private var started = false
    var engine = Engine(); private set
    var api: WardenApi? = null; private set
    var offline = false; private set
    private var launcherRaw: JsonElement? = null
    private var launcherAt = 0L
    private var lastInstalledReport = 0L
    private var lastEnforced = ""
    private var notified = 0L
    private var pinFailures = 0
    private var pinBlockedUntil = 0L
    private var unlockFailures = 0
    private var fast = false
    private var syncNow = false
    private val installResults = mutableListOf<JsonObject>()
    private val playInstalled = mutableListOf<Pair<String, String>>()
    private var lastFg: String? = null
    private var lastEventQuery = 0L
    /** The app the kid opened from the launcher last (used when Android won't tell us what's in front). */
    var launched: String? = null
    /** A website tile is open (SiteActivity): it uses the day's time like an app. */
    @Volatile var siteInFront = false
    /** The launcher is in front again (nothing else is being used). */
    fun atHome() { launched = null; lastFg = null }
    /** The launcher page, when it's open. */
    var page: ((String) -> Unit)? = null

    // Our own steady clock: changing the phone's clock does nothing (the server's time corrects it at every sync).
    private val anchorWall = System.currentTimeMillis()
    private val anchorMono = SystemClock.elapsedRealtime()
    fun now() = anchorWall + (SystemClock.elapsedRealtime() - anchorMono)

    val version: String get() = runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "0"
    val paired get() = store.pairing != null
    val snap: Snapshot? get() = engine.state.snap
    private val rules get() = snap?.phone?.rules ?: PhoneRules()
    private val watchOnly get() = snap?.watchOnly == true

    fun init(context: Context) {
        if (::ctx.isInitialized) return
        ctx = context.applicationContext
        store = Store(ctx)
        policy = Policy(ctx)
        apps = Apps(ctx)
        engine = Engine(store.loadState())
        launcherRaw = store.loadLauncher()?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() }
        store.pairing?.let { api = WardenApi(it.server, it.token) }
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("kids", "Family Screen Warden", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel("service", "Screen time", NotificationManager.IMPORTANCE_MIN))
        nm.createNotificationChannel(NotificationChannel("calls", "Phone calls", NotificationManager.IMPORTANCE_HIGH).apply { setSound(null, null) })
    }

    /** Called by KidsService: the 1-second clock, the server check-ins and the launcher extras. */
    fun start() {
        if (started) return
        started = true
        policy.base()
        Calls.start(ctx)
        scope.launch {
            var last = SystemClock.elapsedRealtime()
            while (true) {
                val t = SystemClock.elapsedRealtime()
                val dt = ((t - last) / 1000.0).coerceIn(0.0, 5.0)
                last = t
                runCatching { step(dt) }.onFailure { Log.w(TAG, "step: ${it.message}") }
                delay(1000)
            }
        }
        scope.launch {
            var first = true
            while (true) {
                if (paired) runCatching { syncOnce() }.onFailure { Log.w(TAG, "sync: ${it.message}") }
                val waiting = engine.state.asked.isNotEmpty()
                val wait = if (fast) 2 else if ((first && offline) || waiting) 10 else 20
                first = false
                for (i in 0 until wait) { if (syncNow) break; delay(1000) }
                syncNow = false
            }
        }
        scope.launch {
            while (true) {
                if (paired && snap != null && now() - launcherAt > 60_000) refreshLauncher()
                runCatching { installer.upkeep() }
                delay(15_000)
            }
        }
    }

    fun syncSoon() { syncNow = true }

    // ---------------------------------------------------------------- the clock and the rules
    private suspend fun step(dt: Double) {
        if (!paired) return
        val pm = ctx.getSystemService(PowerManager::class.java)
        val kg = ctx.getSystemService(KeyguardManager::class.java)
        val interactive = pm.isInteractive && !kg.isKeyguardLocked
        val s = snap
        val fgPkg = if (interactive) foreground() else null
        val rule = fgPkg?.let { p -> s?.apps?.let { apps.ruleOf(p, it) } }
        val fgKey = rule?.takeIf { it.allowed }?.key ?: if (interactive && siteInFront) "site" else null
        val status: StatusDto
        gate.withLock {
            val n = now()
            engine.tick(n, dt, interactive, fgKey, rule?.free == true, rule?.budgeted == true)
            status = engine.status(n, offline)
            // Grown-up windows (Play Store, phone settings) end.
            engine.state.playUntilMs?.let { if (engine.trueNow(n) >= it) { engine.state.playUntilMs = null; engine.addNotice("The Play Store is closed again.", n) } }
            engine.state.settingsUntilMs?.let { if (engine.trueNow(n) >= it) engine.state.settingsUntilMs = null }
        }
        bedtimeWarn()
        enforce(status)
        notifyNew()
        page?.invoke(pageState(status))
    }

    /** A call started, was answered or ended: update the launcher now; show it if the phone's call screen didn't open. */
    var onCall: ((Boolean) -> Unit)? = null
    fun callChanged(state: Calls.State, before: Calls.State) {
        onCall?.invoke(state != Calls.State.IDLE)
        scope.launch {
            page?.invoke(pageState())
            if (state == Calls.State.IDLE) return@launch
            delay(1500)
            if (Calls.state == Calls.State.IDLE) return@launch
            val front = rawForeground()
            if (front == null || front !in policy.phonePackages()) home()
        }
    }

    /** The app in front according to Android's usage events (null when they aren't allowed). */
    private fun rawForeground(): String? = try {
        val usm = ctx.getSystemService(UsageStatsManager::class.java)
        val t = System.currentTimeMillis()
        val ev = usm.queryEvents(t - 10_000, t)
        val e = UsageEvents.Event()
        var last: String? = null
        while (ev.hasNextEvent()) { ev.getNextEvent(e); if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED) last = e.packageName }
        last
    } catch (_: Exception) { null }

    /** A contact's name for a phone number (calls on the launcher show "Mom", not the number). */
    fun contactName(number: String?): String? =
        number?.let { n -> snap?.phone?.contacts?.firstOrNull { Phone.same(it.phone, n) }?.name }

    /** What's in front right now (Android's usage events, or the app opened from the launcher when they aren't allowed). */
    private fun foreground(): String? {
        val usm = ctx.getSystemService(UsageStatsManager::class.java)
        val t = System.currentTimeMillis()
        try {
            val ev = usm.queryEvents(if (lastEventQuery == 0L) t - 60_000 else lastEventQuery - 2000, t)
            val e = UsageEvents.Event()
            var any = false
            while (ev.hasNextEvent()) {
                ev.getNextEvent(e)
                if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED) { lastFg = e.packageName; any = true }
            }
            lastEventQuery = t
            if (any || lastFg != null) return lastFg?.takeIf { it != ctx.packageName && it !in policy.phonePackages() }
        } catch (_: Exception) { }
        return launched
    }

    fun usageAccess(): Boolean = runCatching {
        val usm = ctx.getSystemService(UsageStatsManager::class.java)
        val t = System.currentTimeMillis()
        usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, t - 86400_000L, t).isNotEmpty()
    }.getOrDefault(false)

    /** Which apps may open right now (Android's lock-task list: anything else can't start, and is closed if open). */
    private fun enforce(status: StatusDto) {
        val s = snap ?: return
        if (!policy.isOwner || watchOnly) return
        val st = engine.state
        val n = engine.trueNow(now())
        val playOpen = st.playUntilMs?.let { n < it } == true
        val settingsOpen = st.settingsUntilMs?.let { n < it } == true
        val allowed = mutableSetOf<String>()
        allowed += policy.phonePackages()
        // Android's permission prompts work even when locked (an app can't get stuck asking).
        allowed += listOf("com.google.android.permissioncontroller", "com.android.permissioncontroller")
        if (status.state != "locked") {
            val rs = s.apps.filter { it.allowed && it.category != "system" && it.key !in status.blockedAppKeys }
            apps.packagesByRule(rs).values.forEach { allowed += it }
            allowed += policy.googlePackages()
            if (playOpen) allowed += policy.playPackages()
        }
        if (settingsOpen) allowed += "com.android.settings"
        val key = "${allowed.sorted()}|${status.state}|$playOpen|$settingsOpen|${json.encodeToString(rules)}|${sitesKey(s)}"
        if (key == lastEnforced) return
        val wasLocked = lastEnforced.contains("|locked|")
        lastEnforced = key
        policy.restrictions(rules, settingsOpen, playOpen || installer.busy, accountsOpen = playOpen)
        Contacts.sync(ctx, s.phone.contacts)
        policy.allowOnly(allowed)
        policy.alwaysOnVpn(true)
        policy.chrome(Sites.allowedNow(s.sites, LocalTime.now()), s.safeSearch)
        if (status.state == "locked" && !wasLocked) home()
        Log.i(TAG, "Allowed now: ${allowed.sorted()} (${status.state})")
    }

    private fun sitesKey(s: Snapshot) = Sites.allowedNow(s.sites, LocalTime.now()).joinToString(",")

    /** Called when an install starts or ends (installing needs the "no installs" lock-down off for a moment). */
    fun reapply() { lastEnforced = ""; scope.launch { val st = gate.withLock { engine.status(now(), offline) }; enforce(st) } }

    private val bedWarned = mutableSetOf<String>()
    private suspend fun bedtimeWarn() {
        val b = snap?.bedtime ?: return
        gate.withLock {
            val t = engine.trueNow(now())
            val left = (b.atMs - t) / 60_000.0
            if (left <= 0 || t >= b.untilMs) return
            for (w in b.warnMinutes.sorted()) {
                if (left > w) continue
                if (bedWarned.add("${b.at}/$w")) engine.addNotice("🌙 Bedtime in ${kotlin.math.ceil(left).toInt().coerceAtLeast(1)} minutes. Finish up!", now())
                break
            }
        }
    }

    /** New messages for the kid (time warnings, answers from grown-ups) as phone notifications. */
    private fun notifyNew() {
        val list = engine.notices().filter { it.id > notified }
        if (list.isEmpty()) return
        notified = list.maxOf { it.id }
        val nm = ctx.getSystemService(NotificationManager::class.java)
        for (x in list.takeLast(2)) {
            val n = NotificationCompat.Builder(ctx, "kids").setSmallIcon(R.drawable.ic_notify).setContentTitle("Family Screen Warden").setContentText(x.text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(x.text)).setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(true).build()
            runCatching { nm.notify((x.id % 100000).toInt(), n) }
        }
        page?.invoke(buildJsonObject { put("type", "toast"); put("text", list.last().text) }.toString())
    }

    /** Brings the launcher (or the lock screen in it) in front. */
    fun home() {
        runCatching { ctx.startActivity(Intent(ctx, LauncherActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)) }
    }

    // ---------------------------------------------------------------- the server
    suspend fun syncOnce() {
        val h = api ?: return
        val (day, general, appsUsed) = engine.usageToReport()
        val unlocks = engine.state.pendingUnlocks.toList()
        val st = gate.withLock { engine.status(now(), offline) }
        val sendInstalled = now() - lastInstalledReport > 6 * 3600_000L
        val results = synchronized(installResults) { installResults.toList() }
        val played = synchronized(playInstalled) { playInstalled.toList() }
        val body = buildJsonObject {
            put("version", version)
            putJsonArray("unlocksUsed") { unlocks.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
            if (day.isNotEmpty()) putJsonObject("usage") {
                put("day", day); put("generalSeconds", general)
                putJsonObject("appSeconds") { appsUsed.forEach { (k, v) -> put(k, v) } }
            }
            if (sendInstalled) putJsonArray("installed") {
                apps.installed(true).take(1000).forEach { a -> add(buildJsonObject { put("name", a.label.take(120)); put("exe", a.pkg.take(200)) }) }
            }
            putJsonArray("blocked") {
                engine.state.blocked.entries.sortedByDescending { it.value.atMs }.take(60).forEach { (pkg, b) ->
                    add(buildJsonObject { put("exe", pkg.take(120)); put("name", b.name.take(120)); put("at", java.time.Instant.ofEpochMilli(b.atMs).toString()) })
                }
            }
            val fg = launched
            putJsonObject("live") {
                put("state", st.state)
                fg?.let { p -> snap?.apps?.let { r -> apps.ruleOf(p, r) }?.let { put("foreground", it.key); put("foregroundName", it.name) } }
                putJsonArray("running") { }
                put("launcher", true)
                put("observeOnly", watchOnly)
            }
            if (results.isNotEmpty()) put("installResults", buildJsonArray { results.forEach { add(it) } })
            if (played.isNotEmpty()) put("playInstalled", buildJsonArray { played.forEach { (p, l) -> add(buildJsonObject { put("package", p); put("label", l) }) } })
            putJsonObject("device") {
                put("model", "${Build.MANUFACTURER} ${Build.MODEL}".take(80))
                put("android", Build.VERSION.RELEASE.take(20))
                val bm = ctx.getSystemService(BatteryManager::class.java)
                put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).coerceIn(0, 100))
                put("charging", bm.isCharging)
                put("deviceOwner", policy.isOwner)
                put("usageAccess", usageAccess())
            }
        }
        try {
            val text = h.post("warden/sync", body)
            val s = json.decodeFromString<Snapshot>(text)
            synchronized(installResults) { installResults.removeAll(results.toSet()) }
            synchronized(playInstalled) { playInstalled.removeAll(played.toSet()) }
            if (sendInstalled) lastInstalledReport = now()
            gate.withLock {
                if (day.isNotEmpty()) engine.markReported(day, general, appsUsed)
                engine.state.pendingUnlocks.removeAll(unlocks.toSet())
                engine.applySnapshot(s, now())
                // A grown-up's "turn off" from the server: on a phone, the screen locks.
                s.shutdown?.id?.takeIf { it.isNotEmpty() && it != engine.state.shutdownId }?.let { engine.state.shutdownId = it; policy.lockNow() }
                store.saveState(engine.state)
            }
            fast = s.fastSync
            offline = false
            installer.queue(s.apkInstalls)
            installer.offerUpdate(s.update)
        } catch (e: WardenApiException) {
            if (!e.reached) offline = true else Log.w(TAG, "The server answered: ${e.message}")
            if (e.status == 401) Log.w(TAG, "This phone was unpaired in the parent console")
        }
    }

    fun noteInstall(id: String, status: String, message: String?, pkg: String? = null, label: String? = null) {
        synchronized(installResults) {
            installResults += buildJsonObject { put("id", id); put("status", status); message?.let { put("message", it.take(400)) }; pkg?.let { put("package", it) }; label?.let { put("label", it.take(120)) } }
        }
        apps.invalidate()
        syncSoon()
    }

    /** An app appeared while a grown-up had the Play Store open: it's the one they said yes to. */
    fun notePackageAdded(pkg: String) {
        apps.invalidate()
        val n = engine.trueNow(now())
        val open = engine.state.playUntilMs?.let { n < it } == true
        if (open && !installer.isOurs(pkg)) {
            val label = apps.label(pkg) ?: pkg
            synchronized(playInstalled) { playInstalled += pkg to label }
            engine.addNotice("$label is installed. It's on your launcher in a moment.", now())
            syncSoon()
        }
        lastEnforced = ""
    }

    private suspend fun refreshLauncher() {
        val h = api ?: return
        try {
            val text = h.post("warden/launcher", JsonObject(emptyMap()))
            launcherRaw = json.parseToJsonElement(text)
            launcherAt = now()
            store.saveLauncher(text)
        } catch (e: WardenApiException) { launcherAt = now() - 30_000 }
    }

    // ---------------------------------------------------------------- the launcher page
    fun pageState(status: StatusDto? = null): String {
        val s = snap
        val st = status ?: engine.status(now(), offline)
        val shown = (s?.apps ?: emptyList()).filter { it.allowed && it.category != "system" }
        val n = engine.trueNow(now())
        val launcher = buildJsonObject {
            put("serverUrl", store.pairing?.server ?: "")
            put("settings", json.encodeToJsonElement(s?.launcher ?: LauncherSettings()))
            put("apps", json.encodeToJsonElement(shown))
            put("sites", json.encodeToJsonElement(s?.sites?.filter { !it.tile.isNullOrEmpty() } ?: emptyList()))
            launcherRaw?.let { put("info", it) }
            engine.state.settingsUntilMs?.takeIf { n < it }?.let { put("desktopUntil", java.time.Instant.ofEpochMilli(it).toString()) }
            put("appVersion", version)
            installer.waiting?.let { put("updateWaiting", it) }
        }
        return buildJsonObject {
            put("type", "state")
            put("status", json.encodeToJsonElement(st))
            put("launcher", launcher)
            put("tiles", json.encodeToJsonElement(apps.tiles(shown)))
            putJsonObject("siteIcons") { }
            putJsonArray("windows") { }
            put("sys", sys())
            putJsonObject("phone") {
                put("emergency", rules().emergencyNumber)
                put("contacts", json.encodeToJsonElement(s?.phone?.contacts ?: emptyList()))
                put("messages", json.encodeToJsonElement(store.loadMessages()))
                Calls.dto { contactName(it) }?.let { put("call", it) }
            }
        }.toString()
    }
    private fun rules() = rules

    private fun sys(): JsonObject {
        val am = ctx.getSystemService(AudioManager::class.java)
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        return buildJsonObject {
            putJsonObject("volume") { put("level", am.getStreamVolume(AudioManager.STREAM_MUSIC) * 100 / max); put("muted", am.isStreamMute(AudioManager.STREAM_MUSIC)) }
            putJsonObject("wifi") { put("connected", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) }
        }
    }

    private fun reply(type: String, ok: Boolean, message: String?) =
        page?.invoke(buildJsonObject { put("type", type); put("ok", ok); message?.let { put("message", it) } }.toString())
    private fun toast(text: String) = page?.invoke(buildJsonObject { put("type", "toast"); put("text", text) }.toString())

    /** A grown-up's PIN (checked by the server), or an emergency code when the server can't be reached. */
    private suspend fun grownUp(pin: String?): Pair<Boolean, String> {
        if (System.currentTimeMillis() < pinBlockedUntil) return false to "Too many wrong tries. Wait a few minutes."
        val p = (pin ?: "").trim()
        if (p.isEmpty()) return false to "Type the PIN."
        val ok = try {
            val r = api!!.post("warden/pin", buildJsonObject { put("pin", p) })
            json.decodeFromString<com.familyscreenwarden.kids.core.ActResult>(r).ok
        } catch (e: WardenApiException) {
            if (e.reached && e.status != 409) false
            else {
                val pr = store.pairing ?: return false to "Not set up."
                val m = UnlockCodes.tryMatch(pr.secret, p, engine.state.highestUnlock, voided = engine.state.voidUnlocks) != null
                if (!m) return false to (if (e.reached) (e.message ?: "No screen PIN yet.") else "Can't reach Family Screen Warden. Use an emergency code from the parent console instead.")
                true
            }
        }
        if (!ok) {
            if (++pinFailures >= 5) { pinBlockedUntil = System.currentTimeMillis() + 5 * 60_000; pinFailures = 0 }
            return false to "That PIN isn't right."
        }
        pinFailures = 0
        return true to ""
    }

    /** Something the kid (or a grown-up) did on the launcher page. */
    fun command(raw: String) = scope.launch {
        val m = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return@launch
        fun s(k: String) = m[k]?.let { runCatching { (it as kotlinx.serialization.json.JsonPrimitive).content }.getOrNull() } ?: ""
        when (s("cmd")) {
            "hello" -> page?.invoke(pageState())
            "home", "front", "switch" -> home()
            "dialog" -> page?.invoke(buildJsonObject { put("type", "dialog"); put("name", s("name")) }.toString())
            "launch" -> launchApp(s("key"))
            "site" -> openSite(s("host"))
            "volume" -> {
                val am = ctx.getSystemService(AudioManager::class.java)
                m["level"]?.toString()?.toIntOrNull()?.let { am.setStreamVolume(AudioManager.STREAM_MUSIC, it * am.getStreamMaxVolume(AudioManager.STREAM_MUSIC) / 100, 0) }
                m["mute"]?.toString()?.toBooleanStrictOrNull()?.let { am.adjustStreamVolume(AudioManager.STREAM_MUSIC, if (it) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE, 0) }
            }
            "power" -> if (s("what") == "sleep") policy.lockNow() else policy.reboot()
            "call" -> contact(s("id"))?.let { Calls.dialing(it.phone); Phone.call(ctx, it.phone) }
            "call-answer" -> { Calls.answer(); page?.invoke(pageState()) }
            "call-end" -> { if (!Calls.hangUp()) toast("Use the phone's red button to hang up."); page?.invoke(pageState()) }
            "call-mute" -> { Calls.mute(m["on"]?.toString() == "true"); page?.invoke(pageState()) }
            "call-speaker" -> { Calls.speaker(m["on"]?.toString() == "true"); page?.invoke(pageState()) }
            "text" -> contact(s("id"))?.let { c ->
                val text = s("text").take(600)
                if (Phone.sms(ctx, c.phone, text)) {
                    store.saveMessages(store.loadMessages() + FamilyMessage(UUID.randomUUID().toString(), c.id, c.name, text, java.time.Instant.now().toString(), mine = true))
                } else toast("That didn't send. Try calling instead.")
            }
            "emergency" -> Phone.emergency(ctx, rules.emergencyNumber)
            "pin" -> { val g = grownUp(s("code")); reply("pin", g.first, g.second) }
            "code" -> redeemOrUnlock(s("code"))
            "desktop" -> {
                val mins = m["minutes"]?.toString()?.toIntOrNull() ?: 0
                if (mins <= 0) { engine.state.settingsUntilMs = null; lastEnforced = ""; return@launch }
                val g = grownUp(s("code"))
                if (!g.first) { toast(g.second); return@launch }
                gate.withLock { engine.state.settingsUntilMs = engine.trueNow(now()) + mins.coerceIn(1, 60) * 60_000L; store.saveState(engine.state) }
                lastEnforced = ""
                val st = gate.withLock { engine.status(now(), offline) }
                enforce(st)
                runCatching { ctx.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
            "act", "parent" -> act(m, s("cmd") == "parent", s("code"))
        }
    }

    private fun contact(id: String) = snap?.phone?.contacts?.firstOrNull { it.id == id }

    private fun launchApp(key: String) {
        val s = snap ?: return
        val pkg = apps.packagesByRule(s.apps.filter { it.key == key && it.allowed }).values.flatten().firstOrNull()
        val i = pkg?.let { apps.launchIntent(it) }
        if (i == null) { toast("Can't find that app on this phone. Ask a grown-up."); return }
        launched = pkg
        lastFg = pkg
        runCatching { ctx.startActivity(i) }.onFailure { toast("That didn't open.") }
    }

    private fun openSite(host: String) {
        val site = snap?.sites?.firstOrNull { Sites.normalize(it.host) == Sites.normalize(host) } ?: return
        if (!Sites.inWindow(site.from, site.to, LocalTime.now())) { toast("That website isn't open right now."); return }
        runCatching { ctx.startActivity(Intent(ctx, SiteActivity::class.java).putExtra("host", Sites.normalize(site.host)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    private suspend fun redeemOrUnlock(code: String) {
        val h = api ?: return
        try {
            val s = json.decodeFromString<Snapshot>(h.post("warden/redeem", buildJsonObject { put("code", code) }))
            gate.withLock { engine.applySnapshot(s, now()); store.saveState(engine.state) }
            reply("code", true, if (s.appKey != null) "Added ${s.minutes} minutes for that app." else "Added ${s.minutes} minutes.")
            return
        } catch (e: WardenApiException) {
            if (UnlockCodes.digits(code).length != 8) { reply("code", false, if (e.reached) e.message else "Can't reach Family Screen Warden. Try again when you're online."); return }
        }
        // An emergency code (works offline).
        val pr = store.pairing ?: return
        val counter = UnlockCodes.tryMatch(pr.secret, code, engine.state.highestUnlock, voided = engine.state.voidUnlocks)
        if (counter == null) {
            if (++unlockFailures >= 5) { pinBlockedUntil = System.currentTimeMillis() + 5 * 60_000; unlockFailures = 0 }
            reply("code", false, "That code isn't right."); return
        }
        unlockFailures = 0
        gate.withLock { engine.applyUnlock(counter, now()); store.saveState(engine.state) }
        reply("code", true, "Unlocked for ${Engine.PASS_MINUTES} minutes.")
        syncSoon()
    }

    private suspend fun act(m: JsonObject, parent: Boolean, code: String) {
        val a = (m["act"] as? JsonObject)?.toMutableMap() ?: return
        fun s(k: String) = a[k]?.let { runCatching { (it as kotlinx.serialization.json.JsonPrimitive).content }.getOrNull() }
        val h = api ?: return
        var action = s("action") ?: return
        if (parent && action != "look") action = "parent"
        if ((action == "look" && parent) || action == "parent") {
            val g = grownUp(code)
            if (!g.first) { toast(g.second); return }
            if (action == "look") a["what"] = kotlinx.serialization.json.JsonPrimitive("grownup")
        }
        if (action == "parent") {
            a["action"] = kotlinx.serialization.json.JsonPrimitive("parent")
            val mins = s("minutes")?.toIntOrNull()
            when (s("what")) {
                "bedtime" -> { gate.withLock { engine.skipBedtime(now(), mins ?: 30); store.saveState(engine.state) }; toast("Open for ${mins ?: 30} minutes. Bedtime comes back after."); return }
                "update" -> { toast(installer.updateNow()); return }
                "play" -> {
                    val pm = rules.playMinutes
                    gate.withLock { engine.state.playUntilMs = engine.trueNow(now()) + pm * 60_000L; store.saveState(engine.state) }
                    lastEnforced = ""
                    enforce(gate.withLock { engine.status(now(), offline) })
                    val i = ctx.packageManager.getLaunchIntentForPackage("com.android.vending")?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (i == null) toast("The Play Store isn't on this phone.") else { ctx.startActivity(i); toast("The Play Store is open for $pm minutes.") }
                    return
                }
            }
        }
        try {
            val r = json.decodeFromString<com.familyscreenwarden.kids.core.ActResult>(h.post("warden/launcher/act", JsonObject(a)))
            if (r.ok) launcherAt = 0
            if (r.ok && action == "parent") syncSoon()
            if (r.message.isNotEmpty() && (action !in setOf("look", "chore") || !r.ok)) toast(r.message)
            if (action == "ask" && r.ok) syncSoon()
        } catch (e: WardenApiException) { toast(if (e.reached) e.message ?: "That didn't work." else "Can't reach Family Screen Warden right now.") }
    }

    /** Ask about an app that isn't allowed (by its package). */
    suspend fun ask(pkg: String, name: String): RequestResult? {
        val h = api ?: return null
        return try {
            val r = json.decodeFromString<RequestResult>(h.post("android/request", buildJsonObject { put("package", pkg); put("name", name) }))
            if (r.id != null && r.status in setOf("sent", "pending")) gate.withLock { engine.state.asked[r.id] = pkg }
            r
        } catch (e: WardenApiException) { RequestResult("error", null, e.message ?: "") }
    }

    // ---------------------------------------------------------------- setup
    suspend fun paired(p: Pairing) {
        store.pairing = p
        api = WardenApi(p.server, p.token)
        gate.withLock { engine = Engine(com.familyscreenwarden.kids.core.LocalState()); store.saveState(engine.state) }
        lastEnforced = ""
        syncOnce()
        refreshLauncher()
    }

    /** A text from a family contact arrived (shown on the launcher, even when time is up). */
    fun incomingSms(from: String, text: String) {
        val c = snap?.phone?.contacts?.firstOrNull { Phone.same(it.phone, from) } ?: return
        store.saveMessages(store.loadMessages() + FamilyMessage(UUID.randomUUID().toString(), c.id, c.name, text.take(600), java.time.Instant.now().toString()))
    }

    fun isFamily(number: String?): Boolean {
        if (number.isNullOrBlank()) return false
        val st = engine.status(now(), offline)
        return snap?.phone?.contacts?.any { (st.state != "locked" || it.always) && Phone.same(it.phone, number) } == true
    }
    val lockedNow: Boolean get() = engine.status(now(), offline).state == "locked"
}
