package com.familyscreenwarden.kids

import android.app.role.RoleManager
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import com.familyscreenwarden.kids.core.PairResult
import com.familyscreenwarden.kids.core.SetupCheck
import com.familyscreenwarden.kids.core.SetupKid
import com.familyscreenwarden.kids.core.json

/**
 * The first screens after Android's own setup: whose phone is this (from the server's setup code in the QR), then the
 * two things Android only lets a person switch on (usage access, call screening). Then the launcher takes over.
 * Without the QR (a test phone), the server's address and a code can be typed.
 */
class SetupActivity : ComponentActivity() {
    private lateinit var box: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Kids.init(this)
        KidsService.start(this)
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor(BG))
            isFillViewport = true
        }
        box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(40), dp(24), dp(32)) }
        scroll.addView(box)
        setContentView(scroll)
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, i -> val s = i.getInsets(WindowInsetsCompat.Type.systemBars()); v.setPadding(s.left, s.top, s.right, s.bottom); i }
        takeLink(intent)
        if (Kids.paired) finishSetup() else start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (takeLink(intent) && !Kids.paired) start()
    }

    /** From the quick-install page: screenwarden://setup?server=https://…&code=ABCD1234 fills in the server and the code.
     *  (The query names "server" and "code" are the ones the server puts in the link and in the setup QR.) */
    private fun takeLink(i: Intent?): Boolean {
        val u = i?.data ?: return false
        if (u.scheme != SCHEME || u.host != "setup" || Kids.paired) return false
        val server = u.getQueryParameter("server")?.trim()?.trimEnd('/')?.takeIf { it.startsWith("https://") || it.startsWith("http://") } ?: return false
        val code = u.getQueryParameter("code")?.filter { it.isLetterOrDigit() }?.take(16)?.takeIf { it.length >= 4 } ?: return false
        Kids.store.setupServer = server
        Kids.store.setupCode = code
        return true
    }

    override fun onResume() {
        super.onResume()
        if (Kids.paired && ::box.isInitialized && box.tag == "finish") finishSetup()
    }

    private fun start() {
        val server = Kids.store.setupServer
        val code = Kids.store.setupCode
        if (server != null && code != null) check(server, code) else typeIt(null)
    }

    private fun typeIt(error: String?) {
        clear()
        title("Set up this phone")
        text(if (Kids.policy.isOwner) "Type the setup code from the parent console (Add a phone). Leave the address as it is unless you run your own server."
             else "Type the setup code from the parent console (Add a phone). Leave the address as it is unless you run your own server. (Opening the app from the download page fills these in.)")
        val server = input("Server address (https://…)", Kids.store.setupServer ?: DEFAULT_SERVER)
        val code = input("Setup code", Kids.store.setupCode ?: "")
        error?.let { text(it, DANGER) }
        button("Next") {
            var h = server.text.toString().trim().trimEnd('/')
            if (h.isNotEmpty() && !h.startsWith("http")) h = "https://$h"
            check(h, code.text.toString().trim())
        }
    }

    private fun check(server: String, code: String) {
        clear(); title("Finding your family…")
        lifecycleScope.launch {
            try {
                val r = json.decodeFromString<SetupCheck>(WardenApi(server).post("warden/setup/check", buildJsonObject { put("code", code) }))
                Kids.store.setupServer = server
                Kids.store.setupCode = code
                pick(server, code, r)
            } catch (e: WardenApiException) {
                typeIt(if (e.reached) e.message else "Can't reach $server. Check the Wi-Fi and the address.")
            }
        }
    }

    private fun pick(server: String, code: String, r: SetupCheck) {
        clear()
        title("Whose phone is this?")
        text("${r.family} · the code works for ${r.minutesLeft} more minutes")
        for (k in r.kids) kidButton(k) { pair(server, code, k) }
        if (r.kids.isEmpty()) text("No kids in this family yet. Add them in the parent console first.", DANGER)
    }

    private fun pair(server: String, code: String, k: SetupKid) {
        clear(); title("Setting up ${k.name}'s phone…")
        lifecycleScope.launch {
            try {
                val body = buildJsonObject {
                    put("code", code); put("memberId", k.id); put("deviceId", Kids.store.deviceId())
                    put("model", "${Build.MANUFACTURER} ${Build.MODEL}".take(80)); put("version", Kids.version)
                }
                val p = json.decodeFromString<PairResult>(WardenApi(server).post("android/pair", body))
                Kids.paired(Pairing(server, p.token, p.secret, p.computerId, k.id, k.name))
                Kids.store.setupCode = null
                SafeVpn.start(this@SetupActivity)
                finishSetup()
            } catch (e: WardenApiException) {
                typeIt(if (e.reached) e.message else "Can't reach Family Screen Warden. Check the Wi-Fi.")
            }
        }
    }

    /** What only a person can switch on, then the launcher. */
    private fun finishSetup() {
        clear()
        box.tag = "finish"
        val name = Kids.store.pairing?.kidName ?: ""
        title(if (name.isNotEmpty()) "Almost done!" else "Almost done")
        val usage = Kids.usageAccess()
        // The phone app: Family Screen Warden' own call screen with family names, and only family can call when it's locked.
        val screening = Build.VERSION.SDK_INT < 29 || Calls.isPhoneApp(this)
        if (!usage) {
            text("1. Let Family Screen Warden see which app is open, so it can count $name's time. Find “Family Screen Warden” in the list and switch it on.")
            button("Allow usage access") { runCatching { startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) } }
        } else text("✓ Usage access is on.", GREEN)
        if (!screening) {
            text("2. Make Family Screen Warden the phone app, so calls show the kids' call screen with family names (and only family can call when time is up). Pick Family Screen Warden when Android asks.")
            button("Make it the phone app") {
                if (Build.VERSION.SDK_INT >= 29) runCatching { startActivityForResult(getSystemService(RoleManager::class.java).createRequestRoleIntent(RoleManager.ROLE_DIALER), 7) }
            }
        } else text("✓ Family Screen Warden is the phone app.", GREEN)
        val texting = android.provider.Telephony.Sms.getDefaultSmsPackage(this) == packageName
        if (!texting) {
            text("Make Family Screen Warden the texting app, so $name texts family and friends you said yes to (and you can read the texts in the parent console). Pick Family Screen Warden when Android asks.")
            button("Make it the texting app") {
                runCatching {
                    if (Build.VERSION.SDK_INT >= 29) startActivityForResult(getSystemService(RoleManager::class.java).createRequestRoleIntent(RoleManager.ROLE_SMS), 8)
                    else startActivity(Intent(android.provider.Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT).putExtra(android.provider.Telephony.Sms.Intents.EXTRA_PACKAGE_NAME, packageName))
                }
            }
        } else text("✓ Family Screen Warden is the texting app.", GREEN)
        if (!Kids.policy.isOwner) {
            text("3. Make Family Screen Warden the home screen, so it opens first: pick Screen Warden, then “Always” or “Set as default”.")
            button("Choose the home screen") { runCatching { startActivity(Intent(Settings.ACTION_HOME_SETTINGS)) } }
            text("Installed from a download, the app counts time and shows the launcher, but it can't lock the phone down. For full lock-down, factory reset the phone and use the setup QR code from the parent console.", WARN)
        }
        button(if (usage && screening) "Start" else "Skip for now") {
            startActivity(Intent(this, LauncherActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            finish()
        }
    }

    // ------------------------------------------------------------------ a few simple views (Family Screen Warden colours)
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun clear() { box.removeAllViews(); box.tag = null }
    private fun title(t: String) = box.addView(TextView(this).apply { text = t; textSize = 28f; setTextColor(Color.parseColor(TEXT)); setTypeface(typeface, android.graphics.Typeface.BOLD); setPadding(0, dp(12), 0, dp(12)) })
    private fun text(t: String, color: String = MUTED) = box.addView(TextView(this).apply { text = t; textSize = 16f; setTextColor(Color.parseColor(color)); setPadding(0, dp(6), 0, dp(10)) })
    private fun input(hint: String, value: String): EditText = EditText(this).apply {
        this.hint = hint; setText(value); setTextColor(Color.parseColor(TEXT)); setHintTextColor(Color.parseColor(MUTED)); textSize = 17f
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(Color.parseColor(INSET)); setStroke(dp(1), Color.parseColor(LINE)) }
        setPadding(dp(16), dp(14), dp(16), dp(14))
        box.addView(this, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) })
    }
    private fun button(t: String, onClick: () -> Unit) = box.addView(Button(this).apply {
        text = t; isAllCaps = false; textSize = 17f; setTextColor(Color.parseColor(GREEN_INK)); setTypeface(typeface, android.graphics.Typeface.BOLD)
        background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(Color.parseColor(GREEN)) }
        minHeight = dp(52)
        setOnClickListener { onClick() }
    }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8); bottomMargin = dp(8) })
    private fun kidButton(k: SetupKid, onClick: () -> Unit) = box.addView(Button(this).apply {
        text = (k.avatar?.let { "$it  " } ?: "") + k.name; isAllCaps = false; textSize = 19f; setTextColor(Color.parseColor(TEXT)); gravity = Gravity.CENTER_VERTICAL or Gravity.START
        setPadding(dp(20), 0, dp(20), 0)
        // A card with the kid's colour as its border.
        background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(Color.parseColor(CARD)); setStroke(dp(2), runCatching { Color.parseColor(k.color) }.getOrDefault(Color.parseColor(LINE))) }
        minHeight = dp(64)
        textAlignment = View.TEXT_ALIGNMENT_VIEW_START
        setOnClickListener { onClick() }
    }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6); bottomMargin = dp(6) })

    companion object {
        /** The address already filled in when a parent types the setup code by hand. */
        const val DEFAULT_SERVER = "https://app.familyscreenwarden.com"
        const val SCHEME = "screenwarden"
        // The Family Screen Warden colours (the same tokens as the launcher page).
        private const val BG = "#04060f"
        private const val CARD = "#080c22"
        private const val INSET = "#0e1433"
        private const val LINE = "#2a3468"
        private const val TEXT = "#eef1fb"
        private const val MUTED = "#8e9ac0"
        private const val GREEN = "#34d399"
        private const val GREEN_INK = "#06281c"
        private const val WARN = "#fbbf24"
        private const val DANGER = "#fca5a5"
    }
}
