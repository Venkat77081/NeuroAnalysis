package com.neurocapture.capturekit

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.Data
import com.google.crypto.tink.integration.android.AndroidKeystoreKmsClient
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Process-wide CaptureKit storage shared by the plugin and the upload worker (which also runs
 * when the WebView or the whole UI is gone): Keystore master key, take vault, app store, upload queue.
 */
object Services {
    @Volatile private var vaultRef: TakeVault? = null
    @Volatile private var storeRef: SecureStore? = null
    @Volatile private var queueRef: UploadQueue? = null

    /** Set by the plugin while it is loaded; the worker reports progress through it. */
    @Volatile var uploadListener: ((JSONObject) -> Unit)? = null

    private const val MASTER_KEY_URI = "android-keystore://neurocapture_master_v1"

    @Synchronized
    private fun init(context: Context) {
        if (vaultRef != null) return
        val app = context.applicationContext
        val master = AndroidKeystoreKmsClient.getOrGenerateNewAeadKey(MASTER_KEY_URI)
        vaultRef = TakeVault(File(app.noBackupFilesDir, "takes"), master)
        storeRef = SecureStore(File(app.noBackupFilesDir, "store"), master)
        // Separate directory, so the app's key listing never sees upload records.
        queueRef = UploadQueue(SecureStore(File(app.noBackupFilesDir, "uploads"), master)) { r ->
            uploadListener?.invoke(r.status())
        }
    }

    fun vault(context: Context): TakeVault { init(context); return vaultRef!! }
    fun store(context: Context): SecureStore { init(context); return storeRef!! }
    fun queue(context: Context): UploadQueue { init(context); return queueRef!! }

    private const val UPLOAD_WORK = "nc-upload"
    private const val RETENTION_WORK = "nc-upload-retention"

    /**
     * Schedules the upload worker: Wi-Fi-only uses an unmetered-network constraint; failures back
     * off exponentially from 30 s (WorkManager caps the delay at 5 h). Survives reboots.
     */
    fun kickUploads(context: Context) {
        val q = queue(context)
        val wifiOnly = q.settings()?.wifiOnly ?: true
        if (wifiOnly && !onUnmetered(context)) q.markWaiting(UploadQueue.WIFI_REQUIRED)
        val req = OneTimeWorkRequest.Builder(UploadWorker::class.java)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(UPLOAD_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
    }

    /** Wakes up once to delete local copies whose retention time has passed (no network needed). */
    fun scheduleRetention(context: Context, atMs: Long) {
        val delay = (atMs - System.currentTimeMillis()).coerceAtLeast(0)
        val req = OneTimeWorkRequest.Builder(UploadWorker::class.java)
            .setInitialDelay(delay, TimeUnit.MILLISECONDS)
            .setInputData(Data.Builder().putBoolean(UploadWorker.RETENTION_ONLY, true).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(RETENTION_WORK, ExistingWorkPolicy.REPLACE, req)
    }

    private fun onUnmetered(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }
}

/** Runs the persistent upload queue in the background (DEV_PLAN §5.3: never waits on JavaScript). */
class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val ctx = applicationContext
        val vault = Services.vault(ctx)
        val queue = Services.queue(ctx)
        val delete = { takeId: String -> vault.delete(takeId) }
        if (inputData.getBoolean(RETENTION_ONLY, false)) {
            queue.applyRetention(delete)?.let { Services.scheduleRetention(ctx, it) }
            return Result.success()
        }
        val res = queue.runOnce(
            UrlConnectionHttp(),
            files = { takeId -> try { VaultTakeFiles(vault, takeId) } catch (_: Exception) { null } },
            wrapKey = { takeId, pem -> KeyWrap.wrap(vault.exportDataKeyForWrapping(takeId), pem) },
            deleteTake = delete,
        )
        res.nextRetentionAtMs?.let { Services.scheduleRetention(ctx, it) }
        return if (res.retry) Result.retry() else Result.success()
    }

    companion object {
        const val RETENTION_ONLY = "retentionOnly"
    }
}
