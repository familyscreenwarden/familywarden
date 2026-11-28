package com.familyscreenwarden.kids.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

class StudioTest {
    private fun item(id: String, at: Long, kind: String = StudioRules.PHOTO, up: Boolean = false, failed: Boolean = false, del: Boolean = false, rep: Boolean = false) =
        StudioItem(id, kind, "", at, 0.0, "$id.jpg", "image/jpeg", uploaded = up, upFailed = failed, deleted = del, deleteReported = rep)

    @Test fun rangesForVideoSeeking() {
        assertNull(StudioRules.range(null, 1000))
        assertNull(StudioRules.range("items=0-5", 1000))
        assertNull(StudioRules.range("bytes=0-5,10-20", 1000))
        assertEquals(StudioRules.Range.Part(0, 999), StudioRules.range("bytes=0-", 1000))
        assertEquals(StudioRules.Range.Part(100, 199), StudioRules.range("bytes=100-199", 1000))
        assertEquals(100L, (StudioRules.range("bytes=100-199", 1000) as StudioRules.Range.Part).length)
        assertEquals(StudioRules.Range.Part(500, 999), StudioRules.range("bytes=500-5000", 1000))
        assertEquals(StudioRules.Range.Part(800, 999), StudioRules.range("bytes=-200", 1000))
        assertEquals(StudioRules.Range.Part(0, 999), StudioRules.range("bytes=-5000", 1000))
        assertEquals(StudioRules.Range.Unsatisfiable, StudioRules.range("bytes=1000-", 1000))
        assertEquals(StudioRules.Range.Unsatisfiable, StudioRules.range("bytes=-0", 1000))
        assertNull(StudioRules.range("bytes=20-10", 1000))
        assertNull(StudioRules.range("bytes=abc-", 1000))
    }

    @Test fun whatSyncsAndWhen() {
        val items = listOf(
            item("new", 300), item("old", 100), item("done", 50, up = true),
            item("toobig", 10, failed = true), item("gone", 200, del = true),
            item("goneUp", 20, up = true, del = true), item("goneTold", 30, up = true, del = true, rep = true),
        )
        assertEquals(listOf("old", "gone", "new"), StudioRules.pendingUploads(items, 5).map { it.id })
        assertEquals(listOf("old", "gone"), StudioRules.pendingUploads(items, 2).map { it.id })
        assertEquals(listOf("goneUp"), StudioRules.pendingDeletes(items).map { it.id })
        assertEquals(listOf("goneTold"), StudioRules.purgeable(items).map { it.id })
        assertEquals(listOf("new", "old", "done", "toobig"), StudioRules.visible(items).map { it.id })
    }

    @Test fun uploadAnswers() {
        val i = item("a", 1)
        assertEquals(true, StudioRules.afterUpload(i, 201)?.uploaded)
        assertEquals(true, StudioRules.afterUpload(i, 409)?.uploaded)
        assertEquals(true, StudioRules.afterUpload(i, 413)?.upFailed)
        assertEquals(true, StudioRules.afterUpload(i, 415)?.upFailed)
        assertNull(StudioRules.afterUpload(i, 500))
        assertNull(StudioRules.afterUpload(i, 401))
    }

    @Test fun uploadHeaders() {
        val m = StudioItem("u1", StudioRules.MOVIE, "Zoo day 🦁", 1_800_000_000_000, 47.6, "u1.webm", "video/webm")
        val h = StudioRules.uploadHeaders(m)
        assertEquals("1", h["X-FSW-Upload"])
        assertEquals("video/webm", h["Content-Type"])
        assertEquals("u1", h["X-Media-Id"])
        assertEquals("movie", h["X-Media-Kind"])
        assertEquals("Zoo day 🦁", String(Base64.getDecoder().decode(h["X-Media-Title"]), Charsets.UTF_8))
        assertEquals("1800000000000", h["X-Media-At"])
        assertEquals("48", h["X-Media-Duration"])
        assertEquals("0", StudioRules.uploadHeaders(item("p", 1).copy(durationSec = 3.0))["X-Media-Duration"])
        assertEquals("", StudioRules.uploadHeaders(item("p", 1))["X-Media-Title"])
    }

    @Test fun titlesAndTexts() {
        assertEquals("My movie", StudioRules.cleanTitle("  ", StudioRules.MOVIE))
        assertEquals("", StudioRules.cleanTitle(null, StudioRules.PHOTO))
        assertEquals("Zoo day", StudioRules.cleanTitle(" Zoo\n  day ", StudioRules.MOVIE))
        assertEquals(60, StudioRules.cleanTitle("x".repeat(100), StudioRules.MOVIE).length)
        assertEquals("Mia made a movie for you: https://h/l/1", StudioRules.shareText("Mia Smith", StudioRules.MOVIE, listOf("https://h/l/1")))
        assertEquals("Mia made a video for you: https://h/l/1", StudioRules.shareText("Mia", StudioRules.VIDEO, listOf("https://h/l/1")))
        assertEquals("I made some videos for you:\na\nb", StudioRules.shareText(null, StudioRules.VIDEO, listOf("a", "b")))
    }
}
