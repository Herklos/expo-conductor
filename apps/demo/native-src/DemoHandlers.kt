package software.drakkar.expoconductor.demo

import expo.modules.conductor.ConductorTaskHandler
import expo.modules.conductor.ExpoConductorModule

/**
 * Registers demo Kotlin task handlers for the cross-language lab.
 *
 * Called from [MainApplication.onCreate] via the conductor-rust config plugin, or
 * at any point before tasks fire. Each handler mirrors the archetype behaviour of the
 * matching JS and Rust handlers so performance can be compared across languages.
 *
 * Handler name convention: `lab-{archetype}-kotlin`
 * Task ID convention:      `lab-{archetype}-kotlin`
 */
object DemoHandlers {

    @JvmStatic
    fun register() {
        ExpoConductorModule.registerHandler("lab-calc-kotlin", calcHandler)
        ExpoConductorModule.registerHandler("lab-cpu-kotlin",  cpuHandler)
        ExpoConductorModule.registerHandler("lab-ram-kotlin",  ramHandler)
        ExpoConductorModule.registerHandler("lab-net-kotlin",  netHandler)
        ExpoConductorModule.registerHandler("lab-all-kotlin",  allHandler)
    }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    /** Recursive Fibonacci(35) — moderate CPU, small stack depth. */
    private val calcHandler = ConductorTaskHandler { _, _ ->
        fun fib(n: Long): Long = if (n <= 1L) n else fib(n - 1L) + fib(n - 2L)
        fib(35)
        "success"
    }

    /** Sieve of Eratosthenes to 500 000 — high CPU, ~500 KB BooleanArray. */
    private val cpuHandler = ConductorTaskHandler { _, _ ->
        val limit = 500_000
        val composite = BooleanArray(limit + 1)
        var i = 2
        while (i.toLong() * i <= limit) {
            if (!composite[i]) {
                var j = i * i
                while (j <= limit) { composite[j] = true; j += i }
            }
            i++
        }
        val count = (2..limit).count { !composite[it] }
        check(count > 0) { "sieve produced no primes" }
        "success"
    }

    /** Allocate ~16 MB of doubles, scatter-write, fold to prevent dead-code elim. */
    private val ramHandler = ConductorTaskHandler { _, _ ->
        val n = 2_000_000
        val data = DoubleArray(n)
        val stride = 16_777_619          // prime > n
        var idx = 0
        for (i in 0 until n) {
            data[idx] = i.toDouble()
            idx = (idx + stride) % n
        }
        var max = Double.NEGATIVE_INFINITY
        for (v in data) if (v > max) max = v
        check(max >= 0.0) { "unexpected max" }
        "success"
    }

    /** HTTP GET to Cloudflare CDN trace — real network I/O on device. */
    private val netHandler = ConductorTaskHandler { _, _ ->
        try {
            val url = java.net.URL("https://1.1.1.1/cdn-cgi/trace")
            val conn = url.openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.requestMethod = "GET"
            val code = conn.responseCode
            conn.disconnect()
            if (code in 200..299) "newData" else "failed"
        } catch (_: Exception) {
            "failed"
        }
    }

    /** Sieve(200k) + 8 MB scatter + light network probe. */
    private val allHandler = ConductorTaskHandler { _, _ ->
        // CPU
        val limit = 200_000
        val composite = BooleanArray(limit + 1)
        var i = 2
        while (i.toLong() * i <= limit) {
            if (!composite[i]) {
                var j = i * i
                while (j <= limit) { composite[j] = true; j += i }
            }
            i++
        }

        // RAM
        val n = 1_000_000
        val data = DoubleArray(n)
        val stride = 8_388_617
        var idx = 0
        for (k in 0 until n) { data[idx] = k.toDouble(); idx = (idx + stride) % n }
        var max = Double.NEGATIVE_INFINITY
        for (v in data) if (v > max) max = v

        // Network (best-effort)
        try {
            val url = java.net.URL("https://1.1.1.1/cdn-cgi/trace")
            val conn = url.openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 5_000
            conn.readTimeout = 5_000
            conn.requestMethod = "HEAD"
            conn.responseCode
            conn.disconnect()
        } catch (_: Exception) { /* non-fatal */ }

        "success"
    }
}
