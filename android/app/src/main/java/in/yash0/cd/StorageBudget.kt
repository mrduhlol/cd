package `in`.yash0.cd

import android.content.Context
import android.os.Environment
import android.os.StatFs
import android.os.storage.StorageManager
import android.system.ErrnoException
import android.system.OsConstants
import android.text.format.Formatter
import java.io.IOException

class InsufficientSpaceException(message: String): IOException(message)

object StorageBudget {
    private const val metadataReserve = 262144
    fun reserve(context: Context) {
        val file = java.io.File(context.filesDir, "storage-recovery.reserve")
        if (!file.exists()) java.io.FileOutputStream(file).use { it.write(ByteArray(metadataReserve)); it.fd.sync() }
    }
    fun releaseReserve(context: Context) { java.io.File(context.filesDir, "storage-recovery.reserve").delete() }
    data class Required(val staging: Long, val downloads: Long)
    fun required(size: Long, offset: Long, sameVolume: Boolean, alreadyPublished: Boolean = false): Required {
        require(size >= 0 && offset in 0..size)
        val remaining = size - offset
        val publication = if (alreadyPublished) 0 else size
        return if (sameVolume) Required(Math.addExact(remaining, publication), 0) else Required(remaining, publication)
    }
    fun check(context: Context, size: Long, offset: Long, alreadyPublished: Boolean = false) {
        val downloads = Environment.getExternalStorageDirectory()
        val storage = context.getSystemService(StorageManager::class.java)
        val same = runCatching { storage.getUuidForPath(context.filesDir) == storage.getUuidForPath(downloads) }.getOrDefault(true)
        val needed = required(size, offset, same, alreadyPublished)
        val privateFree = StatFs(context.filesDir.absolutePath).availableBytes
        val downloadFree = StatFs(downloads.absolutePath).availableBytes
        val recoveryAllocation = if (java.io.File(context.filesDir, "storage-recovery.reserve").exists()) 0 else metadataReserve
        val privateRequired = needed.staging + metadataReserve + recoveryAllocation
        if (privateFree < privateRequired || downloadFree < needed.downloads) {
            val missing = maxOf(privateRequired - privateFree, needed.downloads - downloadFree)
            throw InsufficientSpaceException("Not enough storage. Free at least ${Formatter.formatShortFileSize(context, missing)} and tap Resume. CD needs space for the retained file and its Downloads copy.")
        }
        reserve(context)
    }
    fun exhausted(error: Throwable, context: Context): Boolean {
        if (error is InsufficientSpaceException) return true
        var cause: Throwable? = error
        val seen = HashSet<Throwable>()
        while (cause != null && seen.add(cause)) {
            if (cause is ErrnoException && cause.errno in listOf(OsConstants.ENOSPC, OsConstants.EDQUOT)) return true
            cause = cause.cause
        }
        return error is IOException && runCatching { StatFs(context.filesDir.absolutePath).availableBytes < 262144L || StatFs(Environment.getExternalStorageDirectory().absolutePath).availableBytes < 262144L }.getOrDefault(false)
    }
}
