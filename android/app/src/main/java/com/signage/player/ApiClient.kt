package com.signage.player

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

/** Talks to the CMS player API. All calls run on the IO dispatcher and throw IOException on network trouble. */
class ApiClient(baseUrl: String) {
    private val base = baseUrl.trimEnd('/')

    suspend fun register(info: Map<String, String>): Registration {
        val body = JSONObject().put("info", JSONObject(info as Map<*, *>)).toString()
        val o = JSONObject(request("POST", "/api/player/register", body = body))
        return Registration(o.getString("code"), o.getString("pollToken"))
    }

    suspend fun pairStatus(pollToken: String): PairStatus {
        val (code, text) = requestRaw("GET", "/api/player/pair-status?pollToken=" + java.net.URLEncoder.encode(pollToken, "UTF-8"))
        if (code == 404) return PairStatus.Expired
        if (code !in 200..299) throw IOException("HTTP $code")
        val o = JSONObject(text)
        return if (o.getString("status") == "paired") {
            PairStatus.Paired(o.getString("deviceId"), o.optString("deviceName"), o.getString("deviceToken"))
        } else {
            PairStatus.Pending(o.optString("code"))
        }
    }

    /** Returns the raw JSON so the caller can store exactly what it played. */
    suspend fun manifest(token: String): String {
        val (code, text) = requestRaw("GET", "/api/player/manifest", token = token)
        if (code == 401) throw UnpairedException()
        if (code !in 200..299) throw IOException("HTTP $code")
        return text
    }

    /** Downloads to [dest] via a temp file and checks the SHA-256, so a half-written file is never played. */
    suspend fun download(path: String, token: String, dest: File, expectedSha256: String, onProgress: (Long) -> Unit): Unit =
        withContext(Dispatchers.IO) {
            val part = File(dest.parentFile, dest.name + ".part")
            val conn = open("GET", path, token)
            try {
                if (conn.responseCode == 401) throw UnpairedException()
                if (conn.responseCode !in 200..299) throw IOException("HTTP ${conn.responseCode} for $path")
                val digest = MessageDigest.getInstance("SHA-256")
                var total = 0L
                conn.inputStream.use { input ->
                    part.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            coroutineContext.ensureActive()
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            digest.update(buf, 0, n)
                            total += n
                            onProgress(total)
                        }
                    }
                }
                val actual = digest.digest().joinToString("") { "%02x".format(it) }
                if (!actual.equals(expectedSha256, ignoreCase = true)) {
                    part.delete()
                    throw IOException("Checksum mismatch for $path")
                }
                if (!part.renameTo(dest)) throw IOException("Could not save ${dest.name}")
                Unit
            } finally {
                conn.disconnect()
                if (part.exists()) part.delete()
            }
        }

    private suspend fun request(method: String, path: String, body: String? = null, token: String? = null): String {
        val (code, text) = requestRaw(method, path, body, token)
        if (code !in 200..299) throw IOException("HTTP $code")
        return text
    }

    private suspend fun requestRaw(method: String, path: String, body: String? = null, token: String? = null): Pair<Int, String> =
        withContext(Dispatchers.IO) {
            val conn = open(method, path, token)
            try {
                if (body != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.outputStream.use { it.write(body.toByteArray()) }
                }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                code to (stream?.bufferedReader()?.use { it.readText() } ?: "")
            } finally {
                conn.disconnect()
            }
        }

    private fun open(method: String, path: String, token: String?): HttpURLConnection {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        conn.setRequestProperty("X-Player-Version", BuildConfig.VERSION_NAME)
        if (token != null) conn.setRequestProperty("Authorization", "Device $token")
        return conn
    }
}
