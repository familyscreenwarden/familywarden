package com.familyscreenwarden.kids.admin

import android.app.Activity
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import com.familyscreenwarden.kids.Kids
import com.familyscreenwarden.kids.KidsService
import com.familyscreenwarden.kids.SetupActivity

/**
 * The device-owner part. Android's setup screen (6 taps on the welcome screen, then the Family Screen Warden QR code) downloads
 * this app, makes it the device owner, and hands over the extras from the QR code: the server's address and a setup code.
 */
class KidsAdminReceiver : DeviceAdminReceiver() {
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        Kids.init(context)
        @Suppress("DEPRECATION") val extras = intent.getParcelableExtra<PersistableBundle>(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
        saveExtras(extras)
        Kids.policy.base()
        KidsService.start(context)
        // Android 9-11 finish setup here; newer versions use PolicyComplianceActivity.
        context.startActivity(Intent(context, SetupActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    override fun onEnabled(context: Context, intent: Intent) { Kids.init(context) }

    companion object {
        fun saveExtras(b: PersistableBundle?) {
            if (b == null) return
            b.getString("server")?.takeIf { it.startsWith("http") }?.let { Kids.store.setupServer = it.trimEnd('/') }
            b.getString("code")?.takeIf { it.isNotBlank() }?.let { Kids.store.setupCode = it }
        }
    }
}

/** Android 12+: which kind of setup this is (always a fully managed phone). */
class ProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Kids.init(this)
        @Suppress("DEPRECATION") KidsAdminReceiver.saveExtras(intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE))
        val result = Intent().putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE)
        setResult(RESULT_OK, result)
        finish()
    }
}

/** Android 12+: the app's own setup step, right after it became the device owner. */
class PolicyComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Kids.init(this)
        @Suppress("DEPRECATION") KidsAdminReceiver.saveExtras(intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE))
        Kids.policy.base()
        KidsService.start(this)
        setResult(RESULT_OK)
        finish()
        // After Android's setup closes, the launcher (home) opens and sends an unpaired phone to the setup screens.
        if (Build.VERSION.SDK_INT < 33) startActivity(Intent(this, SetupActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
