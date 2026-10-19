package com.signage.player

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import java.io.File

/** Background music: loops a list of audio files quietly, independent of what the zones show. */
class MusicPlayer(private val context: Context) {
    private var exo: ExoPlayer? = null
    private var playing: List<String> = emptyList()

    val isOn get() = playing.isNotEmpty()

    /** Starts, changes or stops the music. Only files already downloaded are played; the rest join later. */
    fun play(music: Music?, media: Map<String, MediaFile>, fileOf: (MediaFile) -> File?) {
        val files = music?.mediaIds.orEmpty().mapNotNull { id -> media[id]?.let(fileOf) }
        val key = files.map { it.path }
        if (key == playing) {
            music?.let { exo?.volume = it.volume }
            return
        }
        playing = key
        if (files.isEmpty()) {
            exo?.stop()
            return
        }
        val player = exo ?: ExoPlayer.Builder(context).build().also { exo = it }
        player.setMediaItems(files.map { MediaItem.fromUri(Uri.fromFile(it)) })
        player.repeatMode = Player.REPEAT_MODE_ALL
        player.volume = music!!.volume
        player.prepare()
        player.playWhenReady = true
    }

    fun release() {
        exo?.release()
        exo = null
        playing = emptyList()
    }
}
