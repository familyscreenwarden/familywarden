package com.familyscreenwarden.kids.core

import java.time.LocalTime

/**
 * Safe browsing's website check, the same as the Windows app's (and the server's own check):
 *  - the kid's sites are always allowed (in their time window)
 *  - mode "sites": nothing else
 *  - mode "filtered" / "open": anything but the blocked hosts (subdomains too) and names with a blocked word
 */
object WebFilter {
    fun onList(host: String, list: List<String>): Boolean {
        val h = Sites.normalize(host)
        return list.any { raw -> val l = Sites.normalize(raw); l.isNotEmpty() && (h == l || h.endsWith(".$l")) }
    }

    /** A blocked word as a whole part of the name ("free-porn.net"), not inside another word ("essex.ac.uk"). */
    fun hasWord(host: String, words: List<String>): Boolean {
        if (words.isEmpty()) return false
        val set = words.toSet()
        return Sites.normalize(host).split('.', '-').any { it in set }
    }

    fun onKidsList(host: String, sites: List<SiteRule>, t: LocalTime): Boolean = onList(host, Sites.allowedNow(sites, t))

    fun blocked(host: String, web: WebInfo, sites: List<SiteRule>, t: LocalTime): Boolean {
        if (onKidsList(host, sites, t)) return false
        if (web.mode != "filtered" && web.mode != "open") return true
        return onList(host, web.block) || hasWord(host, web.words)
    }

    /**
     * For the phone-wide DNS filter (every app). With "only the kid's sites" nothing is refused there: apps need their
     * own servers, and Chrome and the site browser keep to the list themselves.
     */
    fun dnsBlocked(host: String, web: WebInfo, sites: List<SiteRule>, t: LocalTime): Boolean =
        (web.mode == "filtered" || web.mode == "open") && blocked(host, web, sites, t)
}
