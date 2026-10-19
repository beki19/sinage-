package com.signage.player

import android.content.Context
import java.io.File

/** Media files stored on the device, one per CMS media id. */
class ContentCache(context: Context) {
    private val dir = File(context.filesDir, "media").apply { mkdirs() }

    fun fileFor(item: ManifestItem): File = File(dir, item.mediaId + extensionFor(item.mime))

    /** A file only lands at its final name after its checksum passed, so existence + size is enough here. */
    fun isCached(item: ManifestItem): Boolean {
        val f = fileFor(item)
        return f.exists() && (item.size <= 0 || f.length() == item.size)
    }

    /** Ensures every item is on disk. Throws on the first failure; already-downloaded files are kept. */
    suspend fun sync(
        api: ApiClient,
        token: String,
        items: List<ManifestItem>,
        onProgress: (done: Int, total: Int, bytes: Long) -> Unit,
    ) {
        val missing = items.distinctBy { it.mediaId }.filterNot { isCached(it) }
        missing.forEachIndexed { i, item ->
            api.download(item.url, token, fileFor(item), item.sha256) { bytes -> onProgress(i, missing.size, bytes) }
        }
    }

    /** Deletes media no longer in the playlist so the device doesn't fill up. */
    fun prune(keep: List<ManifestItem>) {
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
