package com.familyscreenwarden.kids.core

/**
 * Which parent's rule an app on the phone belongs to. A rule lists Android package names in its exes (added when the
 * phone reports it, a pushed APK installs, or a parent allows it from a request), or matches by name: an app the
 * kid asked for by name ("Toca Boca World") is allowed under that name (the server's app key).
 */
object AppMatch {
    /** The server's appKey(name): lower case, words joined with "-". */
    fun key(name: String): String =
        java.text.Normalizer.normalize(name.lowercase(), java.text.Normalizer.Form.NFKD)
            .replace(Regex("[^a-z0-9]+"), "-").trim('-').take(60).ifEmpty { "app" }

    private fun squash(s: String) = s.lowercase().filter { it.isLetterOrDigit() }

    fun ruleFor(app: InstalledApp, rules: List<AppRule>): AppRule? {
        val pkg = app.pkg.lowercase()
        rules.firstOrNull { r -> r.exes.any { it.lowercase() == pkg } }?.let { return it }
        val k = key(app.label)
        rules.firstOrNull { it.key == k }?.let { return it }
        val sq = squash(app.label)
        if (sq.length >= 4) rules.firstOrNull { squash(it.name) == sq }?.let { return it }
        return null
    }
}
