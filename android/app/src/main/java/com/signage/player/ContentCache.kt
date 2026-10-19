package com.signage.player

import android.content.Context
import java.io.File

/** Media files stored on the device, one per CMS media id. */
class ContentCache(context: Context) {
    private val dir = File(context.filesDir, "media").apply { mkdirs() }

    fun fileFor(media: MediaFile): File = File(dir, media.mediaId + extensionFor(media.mime))

    /** A file only lands at its final name after its checksum passed, so existence + size is enough here. */
    fun isCached(media: MediaFile): Boolean {
        val f = fileFor(media)
        return f.exists() && (media.size <= 0 || f.length() == media.size)
    }

    /** Ensures every file is on disk. Throws on the first failure; already-downloaded files are kept. */
    suspend fun sync(
        api: ApiClient,
        token: String,
        media: List<MediaFile>,
        onProgress: (done: Int, total: Int, bytes: Long) -> Unit,
    ) {
        val missing = media.distinctBy { it.mediaId }.filterNot { isCached(it) }
        missing.forEachIndexed { i, m ->
            api.download(m.url, token, fileFor(m), m.sha256) { bytes -> onProgress(i, missing.size, bytes) }
        }
    }

    /** Deletes media no longer used so the device doesn't fill up. */
    fun prune(keep: List<MediaFile>) {
        val keepNames = keep.map { fileFor(it).name }.toSet()
        dir.listFiles()?.forEach { if (it.name !in keepNames) it.delete() }
    }

    private fun extensionFor(mime: String): String = when (mime.lowercase()) {
        "image/jpeg" -> ".jpg"
        "image/png" -> ".png"
        "image/gif" -> ".gif"
        "image/webp" -> ".webp"
        "video/mp4" -> ".mp4"
        "video/webm" -> ".webm"
        "video/quicktime" -> ".mov"
        else -> ""
    }
}
