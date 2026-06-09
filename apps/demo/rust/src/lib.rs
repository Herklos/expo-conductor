/*!
 * `conductor_demo_ffi` — Rust task handlers for the expo-conductor cross-language lab.
 *
 * # Archetypes
 *
 * | Handler name       | Archetype   | Work                                                  |
 * |--------------------|-------------|-------------------------------------------------------|
 * | `lab-calc-rust`    | Simple Calc | Recursive Fibonacci(35) — moderate CPU, small stack   |
 * | `lab-cpu-rust`     | High CPU    | Sieve of Eratosthenes to 500 000                      |
 * | `lab-ram-rust`     | High RAM    | 16 MB Vec<f64> with scatter-write (prime stride)      |
 * | `lab-net-rust`     | High Network| Blocking HTTP/1.0 GET to 1.1.1.1 — real I/O on device |
 * | `lab-all-rust`     | All Heavy   | Sieve(200k) + 8 MB RAM scatter + net probe combined   |
 *
 * # Entry points
 *
 * - `conductor_app_init()` — called by the host app at startup (MainApplication /
 *   AppDelegate); registers all 5 handlers in the `conductor_ffi` registry.
 *
 * The other C symbols (`conductor_dispatch`, `conductor_free_string`) are compiled in
 * from `conductor_ffi` (as an rlib dependency) and exported by this cdylib/staticlib.
 * The host app only links *this* library — not `conductor_ffi` separately.
 *
 * # Verification tiers
 *
 * - **Host (Tier B):** `cargo test` on this machine — handler registration + result
 *   strings (net handler is allowed to return "failed" when there is no network).
 * - **Device (Tier C):** cargo-ndk → jniLibs (Android); cargo lipo → xcframework (iOS).
 */

use std::sync::Arc;
use conductor_ffi::{conductor_register, Handler};

// ---------------------------------------------------------------------------
// conductor_app_init — overrides the no-op from conductor_ffi
// (conductor_ffi is compiled without the `default-app-init` feature so it does
//  NOT emit a `conductor_app_init` symbol; this crate provides it instead)
// ---------------------------------------------------------------------------

/// Called once at app startup. Registers all 5 demo Rust handlers.
///
/// On Android this is called from `MainApplication.onCreate` (via JNI through the
/// config plugin). On iOS it is called from the `AppDelegate` via the bridging header.
#[no_mangle]
pub extern "C" fn conductor_app_init() {
    register_handlers();
}

/// Register all demo handlers. Separated so it is also callable from tests.
pub fn register_handlers() {
    conductor_register("lab-calc-rust", handler_calc());
    conductor_register("lab-cpu-rust",  handler_cpu());
    conductor_register("lab-ram-rust",  handler_ram());
    conductor_register("lab-net-rust",  handler_net());
    conductor_register("lab-all-rust",  handler_all());
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

fn handler_calc() -> Handler {
    Arc::new(|_task_id: &str, _data: &str| -> &'static str {
        // Recursive Fibonacci(35) — deliberately unoptimised to burn a few ms of CPU.
        fn fib(n: u64) -> u64 {
            if n <= 1 { n } else { fib(n - 1) + fib(n - 2) }
        }
        let _ = fib(35);
        "success"
    })
}

fn handler_cpu() -> Handler {
    Arc::new(|_task_id: &str, _data: &str| -> &'static str {
        // Sieve of Eratosthenes to 500 000 — high CPU, moderate allocation (~500 KB bool).
        let limit = 500_000_usize;
        let mut composite = vec![false; limit + 1];
        let mut i = 2_usize;
        while i * i <= limit {
            if !composite[i] {
                let mut j = i * i;
                while j <= limit {
                    composite[j] = true;
                    j += i;
                }
            }
            i += 1;
        }
        // Consume the result so the optimizer can't dead-code-eliminate it.
        let _count = composite.iter().enumerate().skip(2).filter(|(_, &c)| !c).count();
        "success"
    })
}

fn handler_ram() -> Handler {
    Arc::new(|_task_id: &str, _data: &str| -> &'static str {
        // Allocate ~16 MB of f64s, write in a pseudo-random scatter pattern using a
        // large prime stride to maximise cache-miss pressure, then fold to prevent
        // dead-code elimination.
        let n = 2_000_000_usize;
        let mut data = vec![0.0_f64; n];
        let stride = 16_777_619_usize; // prime > n
        let mut idx = 0_usize;
        for i in 0..n {
            data[idx] = i as f64;
            idx = (idx + stride) % n;
        }
        let _ = data.iter().copied().fold(0.0_f64, f64::max);
        "success"
    })
}

fn handler_net() -> Handler {
    Arc::new(|_task_id: &str, _data: &str| -> &'static str {
        // Blocking HTTP/1.0 GET to Cloudflare's public DNS-over-HTTP endpoint.
        // Uses a raw IP (no DNS lookup required).
        // Returns "failed" gracefully when network is unavailable (host CI, airplane mode).
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;

        let addr: std::net::SocketAddr = "1.1.1.1:80".parse().unwrap();
        match TcpStream::connect_timeout(&addr, Duration::from_secs(10)) {
            Err(_) => "failed",
            Ok(mut stream) => {
                let req = b"GET /cdn-cgi/trace HTTP/1.0\r\n\
                             Host: one.one.one.one\r\n\
                             Connection: close\r\n\r\n";
                if stream.write_all(req).is_err() {
                    return "failed";
                }
                let mut buf = vec![0_u8; 4096];
                let _ = stream.read(&mut buf);
                "newData"
            }
        }
    })
}

fn handler_all() -> Handler {
    Arc::new(|_task_id: &str, _data: &str| -> &'static str {
        // Combination of CPU + RAM + a light network probe.

        // CPU — sieve(200 000)
        let limit = 200_000_usize;
        let mut composite = vec![false; limit + 1];
        let mut i = 2_usize;
        while i * i <= limit {
            if !composite[i] {
                let mut j = i * i;
                while j <= limit {
                    composite[j] = true;
                    j += i;
                }
            }
            i += 1;
        }
        let _primes = composite.iter().enumerate().skip(2).filter(|(_, &c)| !c).count();

        // RAM — 8 MB scatter
        let n = 1_000_000_usize;
        let mut data = vec![0.0_f64; n];
        let stride = 8_388_617_usize; // prime > n
        let mut idx = 0_usize;
        for k in 0..n {
            data[idx] = k as f64;
            idx = (idx + stride) % n;
        }
        let _ = data.iter().copied().fold(0.0_f64, f64::max);

        // Network probe (best-effort, failure is non-fatal for this combined task).
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;
        let addr: std::net::SocketAddr = "1.1.1.1:80".parse().unwrap();
        if let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
            let _ = s.write_all(b"HEAD / HTTP/1.0\r\nHost: one.one.one.one\r\n\r\n");
            let mut buf = [0_u8; 256];
            let _ = s.read(&mut buf);
        }

        "success"
    })
}

// ---------------------------------------------------------------------------
// Tests (Tier B — runs on host via `cargo test`)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use conductor_ffi::{conductor_dispatch, conductor_free_string};
    use std::ffi::{CStr, CString};

    fn c(s: &str) -> CString {
        CString::new(s).unwrap()
    }

    fn dispatch(name: &str) -> String {
        let n = c(name);
        let t = c("test-task");
        let d = c("{}");
        let ptr = conductor_dispatch(n.as_ptr(), t.as_ptr(), d.as_ptr());
        assert!(!ptr.is_null());
        let result = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        unsafe { conductor_free_string(ptr) };
        result
    }

    #[test]
    fn register_handlers_then_dispatch_all() {
        register_handlers();

        assert_eq!(dispatch("lab-calc-rust"), "success");
        assert_eq!(dispatch("lab-cpu-rust"),  "success");
        assert_eq!(dispatch("lab-ram-rust"),  "success");

        // Net may return "newData" (network available) or "failed" (no network on CI).
        let net = dispatch("lab-net-rust");
        assert!(
            net == "newData" || net == "failed",
            "lab-net-rust returned unexpected: {net}"
        );

        // All-heavy returns "success" regardless of network availability.
        assert_eq!(dispatch("lab-all-rust"), "success");
    }

    #[test]
    fn conductor_app_init_is_callable() {
        // Ensure the C symbol compiles and doesn't panic.
        conductor_app_init();
    }

    #[test]
    fn unregistered_handler_returns_no_data() {
        let result = dispatch("lab-does-not-exist");
        assert_eq!(result, "noData");
    }
}
