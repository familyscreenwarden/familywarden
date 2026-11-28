package com.familyscreenwarden.kids

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlinx.coroutines.launch

/**
 * "This site is blocked" (safe browsing): the site, why, and "Ask a grown-up" (a yes puts it on the kid's list, on
 * every device). Opened from the blocked-site notification and from the site browser.
 */
class BlockedActivity : ComponentActivity() {
    companion object {
        fun intent(ctx: Context, host: String): Intent =
            Intent(ctx, BlockedActivity::class.java).putExtra("host", host).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }

    private val categories = mapOf(
        "social" to "a social media site", "chat" to "a chat site", "games" to "an online games site", "adult" to "a site for grown-ups",
        "gambling" to "a gambling site", "proxies" to "a way around the filter", "shopping" to "a shopping site", "violence" to "a violent site",
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Kids.init(this)
        val host = intent.getStringExtra("host") ?: return finish()
        val dp = resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()
        // The Family Screen Warden colours (the same tokens as the launcher page and the setup screens).
        fun round(color: String, r: Int, line: String? = null) = GradientDrawable().apply {
            setColor(Color.parseColor(color)); cornerRadius = r * dp
            if (line != null) setStroke(px(1).coerceAtLeast(1), Color.parseColor(line))
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#04060f"))
            setPadding(px(24), px(24), px(24), px(24))
        }
        root.addView(TextView(this).apply {
            text = "Blocked  ·  $host"
            setTextColor(Color.parseColor("#8e9ac0")); textSize = 14f; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
            background = round("#0e1433", 8); setPadding(px(12), px(10), px(12), px(10))
        })
        val mid = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            background = round("#080c22", 10, "#141b3f"); setPadding(px(20), px(20), px(20), px(20))
        }
        // The shield (a line drawing, in the warning colour).
        mid.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_notify); setColorFilter(Color.parseColor("#fbbf24"))
            background = round("#0e1433", 10, "#2a3468"); setPadding(px(16), px(16), px(16), px(16))
            layoutParams = LinearLayout.LayoutParams(px(80), px(80)).apply { gravity = Gravity.CENTER_HORIZONTAL }
        })
        mid.addView(TextView(this).apply {
            text = "This site is blocked"; setTextColor(Color.parseColor("#eef1fb")); textSize = 24f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
            setPadding(0, px(18), 0, px(8))
        })
        val kind = categoryOf(host)
        mid.addView(TextView(this).apply {
            text = if (kind != null) "$host is $kind. Your family's rules don't allow those yet." else "$host isn't allowed by your family's rules."
            setTextColor(Color.parseColor("#8e9ac0")); textSize = 16f; gravity = Gravity.CENTER
        })
        mid.addView(TextView(this).apply {
            text = "Same rules as your computer"; setTextColor(Color.parseColor("#8e9ac0")); textSize = 12f; gravity = Gravity.CENTER
            background = round("#0e1433", 8); setPadding(px(12), px(6), px(12), px(6))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = px(16) }
        })
        root.addView(mid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f).apply { topMargin = px(12); bottomMargin = px(12) })

        val note = TextView(this).apply {
            text = "When you ask, your grown-ups get a message and can allow it with one tap."
            setTextColor(Color.parseColor("#8e9ac0")); textSize = 12f; gravity = Gravity.CENTER; setPadding(0, px(10), 0, 0)
        }
        val ask = Button(this).apply {
            text = "Ask a grown-up"; isAllCaps = false; textSize = 17f; setTextColor(Color.parseColor("#06281c")); typeface = Typeface.DEFAULT_BOLD
            background = round("#34d399", 8); minHeight = px(48)
        }
        ask.setOnClickListener {
            ask.isEnabled = false; ask.text = "Asking…"
            lifecycleScope.launch {
                val r = Kids.askSite(host)
                ask.text = when (r.status) { "sent", "pending" -> "Asked"; "allowed" -> "Allowed"; else -> "Ask a grown-up" }
                ask.isEnabled = r.status !in setOf("sent", "pending", "allowed")
                if (r.message.isNotEmpty()) note.text = r.message
            }
        }
        root.addView(ask, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(Button(this).apply {
            text = "Go back"; isAllCaps = false; textSize = 17f; setTextColor(Color.parseColor("#eef1fb"))
            background = round("#0e1433", 8, "#2a3468"); minHeight = px(48)
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = px(10) })
        root.addView(note)

        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, i ->
            val s = i.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(px(24) + s.left, px(24) + s.top, px(24) + s.right, px(24) + s.bottom); i
        }
    }

    /** The kind of site, from a short list of well-known hosts (only the blocked kinds come with the rules, so a guess by name). */
    private fun categoryOf(host: String): String? {
        val h = com.familyscreenwarden.kids.core.Sites.normalize(host)
        val known = mapOf(
            "social" to listOf("tiktok.com", "instagram.com", "facebook.com", "snapchat.com", "x.com", "twitter.com", "reddit.com", "threads.net", "pinterest.com", "tumblr.com"),
            "chat" to listOf("discord.com", "discord.gg", "omegle.com", "ome.tv", "kik.com", "telegram.org", "whatsapp.com"),
            "games" to listOf("poki.com", "crazygames.com", "coolmathgames.com", "friv.com", "miniclip.com", "roblox.com", "y8.com"),
            "shopping" to listOf("amazon.com", "ebay.com", "temu.com", "shein.com", "walmart.com", "target.com"),
        )
        val id = known.entries.firstOrNull { (_, l) -> l.any { h == it || h.endsWith(".$it") } }?.key ?: return null
        return categories[id]
    }
}
