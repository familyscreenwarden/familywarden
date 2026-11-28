package com.familyscreenwarden.kids

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import com.familyscreenwarden.kids.core.Dns
import com.familyscreenwarden.kids.core.SafeSearch
import com.familyscreenwarden.kids.core.WebFilter
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.time.LocalTime
import java.util.concurrent.Executors

/**
 * Safe browsing for every app on the phone: a VPN that carries only DNS (nothing else goes through it, so it's light).
 * Google, Bing and DuckDuckGo searches get SafeSearch, YouTube gets Restricted Mode (as on Windows), and encrypted-DNS
 * services that would skip this are refused, so apps fall back to normal DNS. Blocked websites (a filtered web, the
 * same list as Windows) get "no such name". The device owner makes it always-on
 * with "block connections without VPN", so it can't be turned off.
 */
class SafeVpn : VpnService() {
    companion object {
        private val DNS_IP = byteArrayOf(10, 111, 222.toByte(), 1)
        private val CLIENT_IP = byteArrayOf(10, 111, 222.toByte(), 2)
        fun start(ctx: Context) { runCatching { ctx.startService(Intent(ctx, SafeVpn::class.java)) } }
    }

    private var tun: ParcelFileDescriptor? = null
    @Volatile private var running = false
    private val pool = Executors.newFixedThreadPool(8)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!running) start()
        return START_STICKY
    }

    private fun start() {
        Kids.init(this)
        val b = Builder()
            .setSession("Family Screen Warden safe browsing")
            .addAddress(InetAddress.getByAddress(CLIENT_IP), 32)
            .addDnsServer(InetAddress.getByAddress(DNS_IP))
            .addRoute(InetAddress.getByAddress(DNS_IP), 32)
            .setBlocking(true)
        runCatching { b.addDisallowedApplication(packageName) }
        tun = runCatching { b.establish() }.getOrNull()
        val fd = tun ?: return
        running = true
        Thread({ loop(fd) }, "safe-dns").start()
    }

    private fun loop(fd: ParcelFileDescriptor) {
        val input = FileInputStream(fd.fileDescriptor)
        val output = FileOutputStream(fd.fileDescriptor)
        val buf = ByteArray(32767)
        while (running) {
            val n = try { input.read(buf) } catch (e: Exception) { break }
            if (n <= 0) continue
            val pkt = Dns.parseUdp(buf, n) ?: continue
            if (pkt.dstPort != 53) continue
            pool.execute {
                val answer = runCatching { answer(pkt.payload) }.getOrNull() ?: return@execute
                val out = Dns.buildUdp(pkt.dst, pkt.src, 53, pkt.srcPort, answer)
                synchronized(output) { runCatching { output.write(out) } }
            }
        }
        running = false
    }

    private fun answer(q: ByteArray): ByteArray? {
        val query = Dns.parseQuery(q) ?: return forward(q)
        if (SafeSearch.isEncryptedDns(query.name)) return Dns.nxdomain(q, query)
        // Safe browsing's blocked sites (the same list as the Windows app), for every app on the phone.
        val s = Kids.snap
        if (s != null && WebFilter.dnsBlocked(query.name, s.web, s.sites, LocalTime.now())) {
            if (query.type == Dns.A || query.type == Dns.AAAA) Kids.siteBlocked(query.name)
            return Dns.nxdomain(q, query)
        }
        val target = SafeSearch.cname(query.name, Kids.snap?.safeSearch)
        if (target != null && (query.type == Dns.A || query.type == Dns.AAAA)) {
            val up = forward(Dns.rename(q, query, target)) ?: return null
            return Dns.cnameAnswer(q, query, target, up)
        }
        return forward(q)
    }

    /** Asks the phone's real DNS server (from Wi-Fi or mobile data), outside the VPN. */
    private fun forward(q: ByteArray): ByteArray? {
        for (server in upstream()) {
            try {
                DatagramSocket().use { s ->
                    protect(s)
                    s.soTimeout = 4000
                    s.send(DatagramPacket(q, q.size, InetSocketAddress(server, 53)))
                    val buf = ByteArray(4096)
                    val p = DatagramPacket(buf, buf.size)
                    s.receive(p)
                    return buf.copyOf(p.length)
                }
            } catch (_: Exception) { }
        }
        return null
    }

    private fun upstream(): List<InetAddress> {
        val cm = getSystemService(ConnectivityManager::class.java)
        val list = mutableListOf<InetAddress>()
        for (n in cm.allNetworks) {
            val caps = cm.getNetworkCapabilities(n) ?: continue
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
            val lp: LinkProperties = cm.getLinkProperties(n) ?: continue
            list += lp.dnsServers.filter { it.address.size == 4 }
        }
        if (list.isEmpty()) list += InetAddress.getByName("1.1.1.1")
        return list.distinct()
    }

    override fun onRevoke() { stop(); super.onRevoke() }
    override fun onDestroy() { stop(); super.onDestroy() }
    private fun stop() {
        running = false
        runCatching { tun?.close() }
        tun = null
        Log.i(Kids.TAG, "Safe browsing stopped")
    }
}
