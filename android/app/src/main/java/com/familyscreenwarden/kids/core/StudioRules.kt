package com.familyscreenwarden.kids.core

import kotlinx.serialization.Serializable
import java.util.Base64

/** A photo, video or movie the kid made with Camera or Movie Maker (Studio keeps the list in studio/index.json). */
@Serializable data class StudioItem(
    val id: String,
    /** photo | video | movie */
    val kind: String,
    val title: String = "",
    val at: Long,
    val durationSec: Double = 0.0,
    val file: String,
    val mime: String,
    val uploaded: Boolean = false,
    /** The server said it can't take this file (too big, wrong kind): not tried again. */
    val upFailed: Boolean = false,
    val shareLink: String? = null,
    /** The kid deleted it: hidden on the phone, the server is told (and the file goes once the server knows). */
    val deleted: Boolean = false,
    val deleteReported: Boolean = false,
)

/** The rules for the kid's photos and videos that don't need Android (tested in StudioTest). */
object StudioRules {
    const val PHOTO = "photo"
    const val VIDEO = "video"
    const val MOVIE = "movie"
    val KINDS = setOf(PHOTO, VIDEO, MOVIE)

    /** What the kid sees in My photos: newest first. */
    fun visible(items: List<StudioItem>) = items.filter { !it.deleted }.sortedByDescending { it.at }

    /** Files the server doesn't have yet, oldest first. Deleted ones go too: grown-ups can see everything the kid made. */
    fun pendingUploads(items: List<StudioItem>, max: Int) = items.filter { !it.uploaded && !it.upFailed }.sortedBy { it.at }.take(max)

    /** Deletions to tell the server about (once it has the file, or never will). */
    fun pendingDeletes(items: List<StudioItem>) = items.filter { it.deleted && !it.deleteReported && (it.uploaded || it.upFailed) }

    /** Deleted, and the server knows: the file can go from the phone. */
    fun purgeable(items: List<StudioItem>) = items.filter { it.deleted && it.deleteReported }

    /** What an upload answer means for the file. */
    fun afterUpload(item: StudioItem, status: Int): StudioItem? = when (status) {
        200, 201, 409 -> item.copy(uploaded = true)
        413, 415 -> item.copy(upFailed = true)
        else -> null
    }

    /** The headers that go with an upload (POST /api/android/media). */
    fun uploadHeaders(item: StudioItem): Map<String, String> = linkedMapOf(
        "X-FSW-Upload" to "1",
        "Content-Type" to item.mime,
        "X-Media-Id" to item.id,
        "X-Media-Kind" to item.kind,
        "X-Media-Title" to Base64.getEncoder().encodeToString(item.title.toByteArray(Charsets.UTF_8)),
        "X-Media-At" to item.at.toString(),
        "X-Media-Duration" to (if (item.kind == PHOTO) 0L else Math.round(item.durationSec)).toString(),
    )

    /** A title from the page: one line, not too long. */
    fun cleanTitle(t: String?, kind: String): String {
        val s = t.orEmpty().replace(Regex("[\\p{Cntrl}]"), " ").replace(Regex("\\s+"), " ").trim().take(60)
        return s.ifEmpty { if (kind == MOVIE) "My movie" else "" }
    }

    /** The text that goes with a video's link in Texts. */
    fun shareText(kidName: String?, kind: String, links: List<String>): String {
        val who = kidName?.trim()?.split(' ')?.firstOrNull()?.takeIf { it.isNotEmpty() } ?: "I"
        val what = if (kind == VIDEO) "a video" else "a movie"
        return if (links.size == 1) "$who made $what for you: ${links[0]}" else "$who made some videos for you:\n" + links.joinToString("\n")
    }

    sealed class Range {
        /** Bytes start..end (both included). */
        data class Part(val start: Long, val end: Long) : Range() { val length get() = end - start + 1 }
        object Unsatisfiable : Range()
    }

    /** An HTTP Range header ("bytes=0-", "bytes=100-199", "bytes=-500") for a file of [size] bytes. Null = the whole
     *  file (no header, or one we don't understand, like several ranges). */
    fun range(header: String?, size: Long): Range? {
        val h = header?.trim() ?: return null
        if (!h.startsWith("bytes=", ignoreCase = true)) return null
        val spec = h.substring(6).trim()
        if (spec.contains(',')) return null
        val dash = spec.indexOf('-')
        if (dash < 0) return null
        val a = spec.substring(0, dash).trim()
        val b = spec.substring(dash + 1).trim()
        if (a.isEmpty()) {
            val n = b.toLongOrNull() ?: return null
            if (n <= 0 || size == 0L) return Range.Unsatisfiable
            return Range.Part(maxOf(0, size - n), size - 1)
        }
        val start = a.toLongOrNull() ?: return null
        val end = if (b.isEmpty()) size - 1 else (b.toLongOrNull() ?: return null)
        if (start < 0) return null
        if (start >= size) return Range.Unsatisfiable
        if (end < start) return null
        return Range.Part(start, minOf(end, size - 1))
    }
}
