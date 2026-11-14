package com.neurocapture.capturekit

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * PII-safe native crash reports (M9). An uncaught exception is turned into a small report
 * (exception class, a redacted message, the top stack frames) and put in the persistent upload
 * queue before the default handler ends the process; it is sent at the next start once an
 * operator is signed in. Native code never holds patient data, and messages are still redacted.
 */
object CrashReporter {
    @Volatile private var installed = false

    fun install(queue: UploadQueue, pluginVersion: String) {
        if (installed) return
        installed = true
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            try {
                queue.enqueueDiagnostic(report(e, pluginVersion, Instant.now().toString()).toString())
            } catch (_: Throwable) {
                // Never let reporting hide the original crash.
            }
            previous?.uncaughtException(thread, e)
        }
    }

    private val LONG_DIGITS = Regex("\\b\\d{6,}\\b")
    private val EMAIL = Regex("[^\\s@]+@[^\\s@]+\\.[^\\s@]+")
    private val BLOB = Regex("[A-Za-z0-9+/]{40,}={0,2}")
    private val PATH = Regex("(/[\\w.-]+){2,}")

    fun redact(s: String): String =
        s.replace(EMAIL, "[email]").replace(BLOB, "[blob]").replace(LONG_DIGITS, "[number]").replace(PATH, "[path]")

    fun report(e: Throwable, pluginVersion: String, at: String): JSONObject {
        val root = generateSequence(e) { it.cause }.last()
        return JSONObject().put("kind", "crash").put(
            "report",
            JSONObject()
                .put("source", "native")
                .put("at", at)
                .put("app_version", "native")
                .put("plugin_version", pluginVersion)
                .put("platform", "android ${android.os.Build.VERSION.RELEASE ?: "?"}".take(40))
                .put("error", root.javaClass.simpleName.take(100))
                .put("message", redact(root.message ?: "").take(500))
                .put(
                    "stack",
                    JSONArray().apply {
                        root.stackTrace.take(30).forEach {
                            put("${it.className}.${it.methodName}(${it.fileName ?: "?"}:${it.lineNumber})".take(200))
                        }
                    },
                ),
        )
    }
}
