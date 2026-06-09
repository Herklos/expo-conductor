import Foundation
import ExpoConductor

/**
 * Registers demo Swift task handlers for the cross-language lab.
 *
 * Called from the AppDelegate via the conductor-rust config plugin. Each handler
 * mirrors the archetype behaviour of the matching JS, Kotlin, and Rust handlers
 * so performance can be compared across languages.
 *
 * Handler name convention: `lab-{archetype}-swift`
 * Task ID convention:      `lab-{archetype}-swift`
 */
@objc public class DemoHandlers: NSObject {

    @objc public static func register() {
        // Boot the Rust layer first: conductor_app_init() populates the Rust handler
        // registry inside the single libconductor_ffi static/dylib. The #else stub in
        // ConductorRustBridge is a no-op when CONDUCTOR_RUST is not defined.
        ConductorRustBridge.appInit()

        ExpoConductorModule.registerHandler(name: "lab-calc-swift", handler: calcHandler)
        ExpoConductorModule.registerHandler(name: "lab-cpu-swift",  handler: cpuHandler)
        ExpoConductorModule.registerHandler(name: "lab-ram-swift",  handler: ramHandler)
        ExpoConductorModule.registerHandler(name: "lab-net-swift",  handler: netHandler)
        ExpoConductorModule.registerHandler(name: "lab-all-swift",  handler: allHandler)
    }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    /// Recursive Fibonacci(35) — moderate CPU, small stack depth.
    private static let calcHandler: ConductorTaskHandler = { _, _ in
        func fib(_ n: Int) -> Int { n <= 1 ? n : fib(n - 1) + fib(n - 2) }
        _ = fib(35)
        return "success"
    }

    /// Sieve of Eratosthenes to 500 000 — high CPU, ~500 KB Bool array.
    private static let cpuHandler: ConductorTaskHandler = { _, _ in
        let limit = 500_000
        var composite = [Bool](repeating: false, count: limit + 1)
        var i = 2
        while i * i <= limit {
            if !composite[i] {
                var j = i * i
                while j <= limit { composite[j] = true; j += i }
            }
            i += 1
        }
        let count = (2...limit).lazy.filter { !composite[$0] }.count
        precondition(count > 0, "sieve produced no primes")
        return "success"
    }

    /// Allocate ~16 MB of Doubles, scatter-write, fold to prevent dead-code elim.
    private static let ramHandler: ConductorTaskHandler = { _, _ in
        let n = 2_000_000
        var data = [Double](repeating: 0.0, count: n)
        let stride = 16_777_619          // prime > n
        var idx = 0
        for i in 0..<n {
            data[idx] = Double(i)
            idx = (idx + stride) % n
        }
        let maxVal = data.max() ?? 0.0
        precondition(maxVal >= 0.0, "unexpected max")
        return "success"
    }

    /// HTTP GET to Cloudflare CDN trace — real network I/O on device.
    private static let netHandler: ConductorTaskHandler = { _, _ in
        var result = "failed"
        let sema = DispatchSemaphore(value: 0)
        guard let url = URL(string: "https://1.1.1.1/cdn-cgi/trace") else { return "failed" }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                result = "newData"
            }
            sema.signal()
        }.resume()
        sema.wait()
        return result
    }

    /// Sieve(200k) + 8 MB scatter + light network probe.
    private static let allHandler: ConductorTaskHandler = { _, _ in
        // CPU
        let limit = 200_000
        var composite = [Bool](repeating: false, count: limit + 1)
        var i = 2
        while i * i <= limit {
            if !composite[i] {
                var j = i * i
                while j <= limit { composite[j] = true; j += i }
            }
            i += 1
        }
        let _ = (2...limit).lazy.filter { !composite[$0] }.count

        // RAM
        let n = 1_000_000
        var data = [Double](repeating: 0.0, count: n)
        let stride = 8_388_617
        var idx = 0
        for k in 0..<n { data[idx] = Double(k); idx = (idx + stride) % n }
        let _ = data.max() ?? 0.0

        // Network (best-effort)
        let sema = DispatchSemaphore(value: 0)
        if let url = URL(string: "https://1.1.1.1/cdn-cgi/trace") {
            var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
            req.httpMethod = "HEAD"
            URLSession.shared.dataTask(with: req) { _, _, _ in sema.signal() }.resume()
            sema.wait()
        }

        return "success"
    }
}
