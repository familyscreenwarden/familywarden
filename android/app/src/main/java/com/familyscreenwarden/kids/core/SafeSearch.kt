package com.familyscreenwarden.kids.core

/**
 * SafeSearch and YouTube Restricted Mode, the way schools do it: when the phone looks up www.google.com, the answer is
 * Google's "forcesafesearch" address instead (the same certificate, so nothing is opened or changed). Same as Windows.
 */
object SafeSearch {
    const val GOOGLE_SAFE = "forcesafesearch.google.com"
    const val BING_SAFE = "strict.bing.com"
    const val YOUTUBE_RESTRICT = "restrict.youtube.com"
    const val DDG_SAFE = "safe.duckduckgo.com"
    private val youTube = setOf("www.youtube.com", "m.youtube.com", "youtube.com", "youtubei.googleapis.com", "youtube.googleapis.com", "www.youtube-nocookie.com")

    /** Where this name should really point (null when nothing applies). */
    fun cname(host: String, s: SafeSearchInfo?): String? {
        if (s == null) return null
        val h = host.trim().lowercase().trimEnd('.')
        if (s.youTube && h in youTube) return YOUTUBE_RESTRICT
        if (s.search) {
            if (h == "www.bing.com" || h == "bing.com") return BING_SAFE
            if (h == "duckduckgo.com" || h == "www.duckduckgo.com") return DDG_SAFE
            if (isGoogleSearch(h)) return GOOGLE_SAFE
        }
        return null
    }

    fun isGoogleSearch(host: String): Boolean {
        var h = host
        if (h.startsWith("www.")) h = h.substring(4)
        if (h == "google.com") return true
        if (!h.startsWith("google.")) return false
        val parts = h.substring(7).split('.')
        return parts.size in 1..2 && parts.all { it.length in 2..3 }
    }

    /** Encrypted-DNS services that would skip the filter: answered with "no such name", so apps fall back to normal DNS. */
    private val dohHosts = setOf(
        "dns.google", "dns.google.com", "8888.google", "cloudflare-dns.com", "one.one.one.one", "1dot1dot1dot1.cloudflare-dns.com",
        "mozilla.cloudflare-dns.com", "dns.quad9.net", "dns9.quad9.net", "doh.opendns.com", "dns.adguard.com", "dns.adguard-dns.com",
        "doh.cleanbrowsing.org", "dns.nextdns.io", "chrome.cloudflare-dns.com", "doh.dns.sb", "dns.brave.com",
        "use-application-dns.net",
    )
    fun isEncryptedDns(host: String) = host.trim().lowercase().trimEnd('.') in dohHosts
}
