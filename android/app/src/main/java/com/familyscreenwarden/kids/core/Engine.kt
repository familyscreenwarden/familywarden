package com.familyscreenwarden.kids.core

import kotlin.math.floor
import kotlin.math.max

/**
 * Time accounting and warnings for one kid on this phone. No Android calls in here, so it is tested on any machine.
 * The server's clock is the reference (changing the phone's clock does nothing): every time is "local now" (a steady
 * clock) plus the offset the last sync measured.
 */
class Engine(val state: LocalState = LocalState()) {
    companion object { const val PASS_MINUTES = 60 }

    private val notices = ArrayDeque<Notice>()
    private var lastNoticeId = 0L

    fun trueNow(localNow: Long) = localNow + state.clockOffsetMs

    fun addNotice(text: String, localNow: Long, askPkg: String? = null, askName: String? = null) {
        val id = max(lastNoticeId + 1, localNow)
        lastNoticeId = id
        notices.addLast(Notice(id, text, askPkg, askName))
        while (notices.size > 20) notices.removeFirst()
    }

    fun notices(): List<Notice> = notices.toList()

    /** A fresh picture from the server. Our own usage stays ours; other devices' usage is the rest. */
    fun applySnapshot(s: Snapshot, localNow: Long) {
        isoMs(s.serverTime)?.let { state.clockOffsetMs = it - localNow }
        if (s.day != state.day) {
            state.day = s.day
            state.ownGeneral = 0.0
            state.ownApps.clear()
            state.reportedGeneral = 0
            state.reportedApps.clear()
            state.warned.clear()
        }
        state.snap = s
        state.dayEndsAtMs = isoMs(s.dayEndsAt) ?: state.dayEndsAtMs
        state.othersGeneral = max(0.0, s.used.generalSeconds - state.reportedGeneral.toDouble())
        state.othersApps.clear()
        for ((k, v) in s.used.appSeconds) state.othersApps[k] = max(0.0, v - (state.reportedApps[k] ?: 0).toDouble())
        state.lastSyncOkMs = localNow
        state.voidUnlocks = s.voidUnlocks.toMutableSet()
        for (r in s.requests) {
            if (r.status == "pending" || state.asked.remove(r.id) == null) continue
            addNotice(if (r.status == "allowed") "A grown-up said yes to ${r.name}." else "A grown-up said no to ${r.name}.", localNow)
        }
        state.asked.keys.filter { k -> s.requests.none { it.id == k } }.forEach { state.asked.remove(it) }
    }

    fun usageToReport(): Triple<String, Int, Map<String, Int>> =
        Triple(state.day, state.ownGeneral.toInt(), state.ownApps.mapValues { it.value.toInt() })

    fun markReported(day: String, general: Int, apps: Map<String, Int>) {
        if (day != state.day) return
        state.reportedGeneral = general
        state.reportedApps = apps.toMutableMap()
    }

    private fun rollDay() {
        val snap = state.snap ?: return
        state.day = java.time.LocalDate.parse(state.day).plusDays(1).toString()
        state.dayEndsAtMs += 24 * 3600_000L
        state.ownGeneral = 0.0; state.ownApps.clear()
        state.othersGeneral = 0.0; state.othersApps.clear()
        state.reportedGeneral = 0; state.reportedApps.clear()
        state.warned.clear()
        // Offline over the reset: today's extras are gone, the base time is what we know.
        state.snap = snap.copy(
            allowance = AllowanceInfo(baseMinutes = snap.allowance.baseMinutes, generalMinutes = snap.allowance.baseMinutes),
            used = UsedInfo(), day = state.day, dayEndsAt = msIso(state.dayEndsAtMs), locked = false,
        )
    }

    fun passActive(localNow: Long) = state.passUntilMs?.let { trueNow(localNow) < it } == true

    fun generalLeft(): Int {
        val s = state.snap ?: return 0
        return floor(s.allowance.generalMinutes * 60.0 - state.ownGeneral - state.othersGeneral).toInt()
    }

    fun appLeft(key: String): Int {
        val s = state.snap ?: return 0
        val mins = s.allowance.appMinutes[key] ?: 0
        return floor(mins * 60.0 - (state.ownApps[key] ?: 0.0) - (state.othersApps[key] ?: 0.0)).toInt()
    }

    /** Seconds left under an app's daily limit (Int.MAX_VALUE when it has none). */
    fun limitLeft(key: String): Int {
        val lim = state.snap?.apps?.firstOrNull { it.key == key }?.limitMinutes ?: return Int.MAX_VALUE
        return floor(lim * 60.0 - (state.ownApps[key] ?: 0.0) - (state.othersApps[key] ?: 0.0)).toInt()
    }

    /** Bedtime right now: the window from the server, unless a grown-up opened the phone for a while. */
    fun bedtimeNow(localNow: Long): BedtimeInfo? {
        val b = state.snap?.bedtime ?: return null
        val t = trueNow(localNow)
        if (t < b.atMs || t >= b.untilMs) return null
        if (state.bedtimeSkipUntilMs?.let { t < it } == true) return null
        return b
    }

    fun skipBedtime(localNow: Long, minutes: Int) {
        val m = minutes.coerceIn(1, 240)
        state.bedtimeSkipUntilMs = trueNow(localNow) + m * 60_000L
        addNotice("A grown-up opened the phone for $m minutes. Bedtime comes back after.", localNow)
    }

    fun locked(localNow: Long): Boolean {
        val s = state.snap ?: return false
        return !passActive(localNow) && (bedtimeNow(localNow) != null || s.locked || (!s.paused && generalLeft() <= 0))
    }

    /**
     * Advance by dt seconds. [interactive]: the screen is on and unlocked. [foreground]: the rule key of the allowed app
     * in front (null: the launcher, the phone app, nothing). Phone time counts only while an app is in front.
     */
    fun tick(localNow: Long, dt: Double, interactive: Boolean, foreground: String?, foregroundFree: Boolean, budgeted: Boolean) {
        val s = state.snap ?: return
        var guard = 0
        while (guard++ < 400 && state.dayEndsAtMs > 0 && trueNow(localNow) >= state.dayEndsAtMs) rollDay()
        val free = s.paused || passActive(localNow) || locked(localNow)
        if (interactive && !free && foreground != null) {
            if (budgeted) {
                if (appLeft(foreground) > 0) state.ownApps[foreground] = (state.ownApps[foreground] ?: 0.0) + dt
            } else {
                if (!foregroundFree) state.ownGeneral += dt
                if (limitLeft(foreground) > 0) state.ownApps[foreground] = (state.ownApps[foreground] ?: 0.0) + dt
            }
        }
        if (interactive && !s.paused && !passActive(localNow)) warn(localNow, foreground, budgeted)
    }

    private fun warn(localNow: Long, fg: String?, budgeted: Boolean) {
        val s = state.snap ?: return
        val left = generalLeft()
        for (m in s.warnMinutes.sortedDescending())
            if (left > 0 && left <= m * 60 && state.warned.add("${state.day}|g|$m")) addNotice("$m minutes of phone time left.", localNow)
        if (left <= 0 && state.warned.add("${state.day}|g|0")) addNotice("Phone time is up for today.", localNow)
        if (fg == null) return
        val name = s.apps.firstOrNull { it.key == fg }?.name ?: fg
        if (budgeted) {
            val l = appLeft(fg)
            for (m in s.warnMinutes.sortedDescending())
                if (l > 0 && l <= m * 60 && state.warned.add("${state.day}|$fg|$m")) addNotice("$m minutes left in $name.", localNow)
            if (l <= 0 && state.warned.add("${state.day}|$fg|0")) addNotice("$name time is up for today.", localNow)
        } else {
            val l = limitLeft(fg)
            if (l == Int.MAX_VALUE) return
            for (m in s.warnMinutes.sortedDescending())
                if (l > 0 && l <= m * 60 && l < left && state.warned.add("${state.day}|$fg|L$m")) addNotice("$m minutes left in $name today.", localNow)
            if (l <= 0 && state.warned.add("${state.day}|$fg|L0")) addNotice("That's all the $name for today.", localNow)
        }
    }

    fun applyUnlock(counter: Long, localNow: Long) {
        state.highestUnlock = max(state.highestUnlock, counter)
        if (!state.pendingUnlocks.contains(counter)) state.pendingUnlocks.add(counter)
        state.passUntilMs = trueNow(localNow) + PASS_MINUTES * 60_000L
        addNotice("A grown-up unlocked this phone for $PASS_MINUTES minutes.", localNow)
    }

    fun noteBlocked(pkg: String, name: String, localNow: Long) {
        state.blocked[pkg] = Blocked(name, trueNow(localNow))
        if (state.blocked.size > 40) state.blocked.entries.sortedBy { it.value.atMs }.take(state.blocked.size - 40).forEach { state.blocked.remove(it.key) }
    }

    fun status(localNow: Long, offline: Boolean = false): StatusDto {
        val s = state.snap ?: return StatusDto(offline = offline)
        val apps = mutableListOf<AppLeft>()
        val blocked = mutableListOf<String>()
        for (a in s.apps.filter { it.allowed && it.budgeted }) {
            val l = appLeft(a.key)
            apps += AppLeft(a.key, a.name, max(0, l))
            if (l <= 0) blocked += a.key
        }
        for (a in s.apps.filter { it.allowed && !it.budgeted && it.limitMinutes != null }) {
            val l = limitLeft(a.key)
            apps += AppLeft(a.key, a.name, max(0, l), "limit", a.limitMinutes!!)
            if (l <= 0) blocked += a.key
        }
        val base = StatusDto(
            kid = s.kid?.name, generalSecondsLeft = max(0, generalLeft()), totalSeconds = s.allowance.generalMinutes * 60,
            apps = apps, offline = offline, dayEndsAt = if (state.dayEndsAtMs > 0) msIso(state.dayEndsAtMs) else null,
        )
        val bed = bedtimeNow(localNow)
        return when {
            passActive(localNow) -> base.copy(state = "pass", passSecondsLeft = max(0L, (state.passUntilMs!! - trueNow(localNow)) / 1000).toInt())
            bed != null -> base.copy(state = "locked", lockReason = "bedtime", bedtimeUntil = bed.until, blockedAppKeys = blocked)
            s.locked -> base.copy(state = "locked", lockReason = "parent", blockedAppKeys = blocked)
            s.paused -> base.copy(state = "paused")
            locked(localNow) -> base.copy(state = "locked", lockReason = "time", blockedAppKeys = blocked)
            else -> base.copy(state = "ok", blockedAppKeys = blocked)
        }
    }
}
