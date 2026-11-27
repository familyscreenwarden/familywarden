package com.familyscreenwarden.kids.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * The shapes the server sends (the same /api/warden answers the Windows app reads; the server keeps the same paths and names), plus
 * what only phones get (phone, apkInstalls). Times are ISO strings from the server; [isoMs] turns them into millis.
 */
val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true; coerceInputValues = true }

fun isoMs(s: String?): Long? = try { if (s.isNullOrBlank()) null else java.time.Instant.parse(s).toEpochMilli() } catch (_: Exception) { null }
fun msIso(ms: Long): String = java.time.Instant.ofEpochMilli(ms).toString()

@Serializable data class Person(val id: String = "", val name: String = "")

@Serializable data class PairResult(
    val token: String = "",
    val secret: String = "",
    val computerId: String = "",
    val name: String = "",
    val member: Person? = null,
)

@Serializable data class AppRule(
    val key: String = "",
    val name: String = "",
    val category: String = "other",
    val exes: List<String> = emptyList(),
    val allowed: Boolean = false,
    val budgeted: Boolean = false,
    val limitMinutes: Int? = null,
    val free: Boolean = false,
)

@Serializable data class SiteRule(val host: String = "", val tile: String? = null, val folder: String? = null, val from: String? = null, val to: String? = null)

@Serializable data class AllowanceInfo(val generalMinutes: Int = 0, val baseMinutes: Int = 0, val extraMinutes: Int = 0, val appMinutes: Map<String, Int> = emptyMap())

@Serializable data class UsedInfo(val generalSeconds: Int = 0, val appSeconds: Map<String, Int> = emptyMap())

@Serializable data class BedtimeInfo(val at: String = "", val until: String = "", val warnMinutes: List<Int> = listOf(10, 5)) {
    val atMs get() = isoMs(at) ?: 0L
    val untilMs get() = isoMs(until) ?: 0L
}

@Serializable data class RequestInfo(val id: String = "", val exe: String = "", val name: String = "", val status: String = "pending")
@Serializable data class RequestResult(val status: String = "", val id: String? = null, val message: String = "")
@Serializable data class SafeSearchInfo(val search: Boolean = true, val youTube: Boolean = true)
@Serializable data class LauncherSettings(val enabled: Boolean = true, val layout: String = "bright", val theme: String = "galaxy", val lookLocked: Boolean = false)
@Serializable data class UpdateInfo(val version: String = "", val url: String = "", val sha256: String = "", val size: Long = 0)
@Serializable data class ShutdownInfo(val id: String = "", val at: String = "")

/** Only for phones: lock-downs, emergency number, how long a grown-up opens the Play Store. */
@Serializable data class PhoneRules(
    val blockSettings: Boolean = true,
    val blockReset: Boolean = true,
    val blockSafeBoot: Boolean = true,
    val blockInstalls: Boolean = true,
    val blockAccounts: Boolean = true,
    val blockUsb: Boolean = true,
    val emergencyNumber: String = "911",
    val playMinutes: Int = 10,
)
@Serializable data class Contact(val id: String = "", val name: String = "", val phone: String = "", val always: Boolean = true)
@Serializable data class PhoneInfo(val rules: PhoneRules = PhoneRules(), val contacts: List<Contact> = emptyList())
/** The texting app: friends a grown-up said yes to, friends asked about, blocked numbers, held texts a grown-up deleted. */
@Serializable data class Friend(val id: String = "", val name: String = "", val phone: String = "")
@Serializable data class AskedFriend(val name: String = "", val phone: String = "", val status: String = "pending")
@Serializable data class TextingInfo(
    val friends: List<Friend> = emptyList(),
    val asked: List<AskedFriend> = emptyList(),
    val blocked: List<String> = emptyList(),
    val drop: List<String> = emptyList(),
)
@Serializable data class ApkInstall(val id: String = "", val name: String = "", val url: String = "", val sha256: String = "", val size: Long = 0)

@Serializable data class Snapshot(
    val serverTime: String = "",
    val day: String = "",
    val dayEndsAt: String = "",
    val paused: Boolean = false,
    val kid: Person? = null,
    val allowance: AllowanceInfo = AllowanceInfo(),
    val used: UsedInfo = UsedInfo(),
    val apps: List<AppRule> = emptyList(),
    val sites: List<SiteRule> = emptyList(),
    val warnMinutes: List<Int> = listOf(10, 5),
    val locked: Boolean = false,
    val shutdown: ShutdownInfo? = null,
    val shutdownCancel: String? = null,
    val requests: List<RequestInfo> = emptyList(),
    val voidUnlocks: List<Long> = emptyList(),
    val safeSearch: SafeSearchInfo = SafeSearchInfo(),
    val launcher: LauncherSettings = LauncherSettings(),
    val watchOnly: Boolean? = null,
    val bedtime: BedtimeInfo? = null,
    val update: UpdateInfo? = null,
    val fastSync: Boolean = false,
    val phone: PhoneInfo = PhoneInfo(),
    val apkInstalls: List<ApkInstall> = emptyList(),
    val texting: TextingInfo? = null,
    // Set by redeem answers only.
    val minutes: Int? = null,
    val appKey: String? = null,
)

/** What the launcher shows besides the rules (POST /api/warden/launcher): kept as raw JSON and passed to the page. */
@Serializable data class ActResult(val ok: Boolean = false, val message: String = "")

/** A setup code's family and kids (POST /api/warden/setup/check). */
@Serializable data class SetupKid(val id: String = "", val name: String = "", val color: String = "#5b7cfa", val avatar: String? = null)
@Serializable data class SetupCheck(val family: String = "", val name: String = "", val oneKid: Boolean = false, val minutesLeft: Int = 0, val kids: List<SetupKid> = emptyList())

/** An app the parent's rules can match: its package and the name it shows. */
data class InstalledApp(val pkg: String, val label: String)

/** Kept between runs. */
@Serializable data class Notice(val id: Long, val text: String, val askPkg: String? = null, val askName: String? = null)

@Serializable data class LocalState(
    var day: String = "",
    var ownGeneral: Double = 0.0,
    var ownApps: MutableMap<String, Double> = mutableMapOf(),
    var othersGeneral: Double = 0.0,
    var othersApps: MutableMap<String, Double> = mutableMapOf(),
    var reportedGeneral: Int = 0,
    var reportedApps: MutableMap<String, Int> = mutableMapOf(),
    var snap: Snapshot? = null,
    var dayEndsAtMs: Long = 0,
    var clockOffsetMs: Long = 0,
    var highestUnlock: Long = 0,
    var passUntilMs: Long? = null,
    var warned: MutableSet<String> = mutableSetOf(),
    var lastSyncOkMs: Long? = null,
    var pendingUnlocks: MutableList<Long> = mutableListOf(),
    var voidUnlocks: MutableSet<Long> = mutableSetOf(),
    /** "Ask a grown-up" sent from here, not answered yet (request id → what). */
    var asked: MutableMap<String, String> = mutableMapOf(),
    /** Apps the kid tried that aren't allowed (package → name, when), for "Recently blocked". */
    var blocked: MutableMap<String, Blocked> = mutableMapOf(),
    var bedtimeSkipUntilMs: Long? = null,
    var shutdownId: String? = null,
    /** A grown-up opened the Play Store until then (to install an app they said yes to). */
    var playUntilMs: Long? = null,
    /** A grown-up opened the phone's settings until then. */
    var settingsUntilMs: Long? = null,
)

@Serializable data class Blocked(val name: String, val atMs: Long)

/** The page's status (the same names the Windows lock screen and launcher use). */
@Serializable data class AppLeft(val key: String, val name: String, val secondsLeft: Int, val kind: String = "own", val limitMinutes: Int = 0)

@Serializable data class StatusDto(
    /** unpaired | ok | paused | pass | locked */
    val state: String = "unpaired",
    val kid: String? = null,
    val generalSecondsLeft: Int = 0,
    val totalSeconds: Int = 0,
    val passSecondsLeft: Int = 0,
    val apps: List<AppLeft> = emptyList(),
    val blockedAppKeys: List<String> = emptyList(),
    val offline: Boolean = false,
    /** time | parent | bedtime */
    val lockReason: String? = null,
    val bedtimeUntil: String? = null,
    val dayEndsAt: String? = null,
)

typealias Raw = JsonElement
