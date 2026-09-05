package com.nightcode.app

import android.content.Context
import android.util.Base64
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.ChannelSftp
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import com.jcraft.jsch.SftpException
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * SSH/SFTP connection manager for the AI agent bridge.
 *
 * One persistent session; every operation reports back to JS through
 * window.__sshData(cbId, chunk) while running and window.__sshDone(cbId,
 * exitCode, error) at the end — mirroring how httpStream reports SSE chunks.
 *
 * Credentials live in the app's private SharedPreferences (same place the
 * API keys already live on the JS side of the app).
 */
class SshManager(
    private val context: Context,
    /** Resolves a project-relative path ("workspace:x/y" aware) to bytes, or null. */
    private val readLocal: (String) -> ByteArray?,
    /** Writes bytes to a project-relative path. Returns true on success. */
    private val writeLocal: (String, ByteArray) -> Boolean
) {
    private var session: Session? = null
    private val lock = Object()

    // ── Config persistence ──────────────────────────────────────────────

    private fun prefs() = context.getSharedPreferences("nightcode_ssh", Context.MODE_PRIVATE)

    fun savedConfig(): String? = prefs().getString("config", null)

    private fun saveConfig(cfg: JSONObject) {
        prefs().edit().putString("config", cfg.toString()).apply()
    }

    fun clearConfig() {
        prefs().edit().remove("config").apply()
    }

    private fun configOrNull(): JSONObject? = try {
        savedConfig()?.let { JSONObject(it) }
    } catch (_: Exception) { null }

    // ── Connection ──────────────────────────────────────────────────────

    val isConnected: Boolean
        get() = synchronized(lock) { session?.isConnected == true }

    /**
     * Connect (or report the live session). Params come as a JSON string:
     * {host, port, user, password, privateKeyB64, passphrase, save}
     * An empty param string reuses the saved config (auto-reconnect).
     */
    fun connect(paramsJson: String, onLine: (String) -> Unit, onDone: (Int, String, Boolean) -> Unit) {
        var cfg = configOrNull()
        if (paramsJson.isNotBlank()) {
            val p = JSONObject(paramsJson)
            cfg = JSONObject().apply {
                put("host", p.optString("host"))
                put("port", p.optInt("port", 22))
                put("user", p.optString("user"))
                put("password", p.optString("password"))
                put("privateKey", p.optString("privateKey"))
                put("passphrase", p.optString("passphrase"))
            }
            if (p.optBoolean("save", true)) saveConfig(cfg!!)
        }
        if (cfg == null || cfg.optString("host").isBlank()) {
            onDone(-1, "NO_CONFIG", true)
            return
        }
        Thread {
            synchronized(lock) {
                try {
                    session?.takeIf { it.isConnected }?.let { onDone(0, "ALREADY_CONNECTED", false); return@Thread }
                    val jsch = JSch()
                    val keyB64 = cfg.optString("privateKey")
                    if (keyB64.isNotBlank()) {
                        val keyBytes = try { Base64.decode(keyB64, Base64.NO_WRAP) } catch (_: Exception) { null }
                        // Tolerate a raw PEM pasted by the user: encode is only
                        // needed because the bridge crosses JS as a string.
                        val bytes = keyBytes ?: keyB64.toByteArray(Charsets.UTF_8)
                        val passphrase = cfg.optString("passphrase")
                        jsch.addIdentity(
                            "nightcode-key",
                            bytes,
                            null,
                            if (passphrase.isNotBlank()) passphrase.toByteArray(Charsets.UTF_8) else null
                        )
                    }
                    val s = jsch.getSession(cfg.optString("user"), cfg.optString("host"), cfg.optInt("port", 22))
                    s.setPassword(cfg.optString("password"))
                    s.setConfig("StrictHostKeyChecking", "no")
                    // Modern Ubuntu servers rotate kex/ciphers; the defaults of
                    // the mwiede fork handle them, keepalive keeps NAT alive.
                    s.setTimeout(30000)
                    s.setServerAliveInterval(30_000)
                    s.setServerAliveCountMax(6)
                    s.connect(30_000)
                    session = s
                    onLine("Connected to ${cfg.optString("user")}@${cfg.optString("host")}")
                    onDone(0, "CONNECTED", false)
                } catch (e: Exception) {
                    session = null
                    onDone(-1, e.message ?: e.toString(), true)
                }
            }
        }.start()
    }

    fun disconnect(onDone: (Int, String, Boolean) -> Unit) {
        synchronized(lock) {
            try {
                session?.disconnect()
            } catch (_: Exception) {}
            session = null
        }
        onDone(0, "DISCONNECTED", false)
    }

    // ── Exec ────────────────────────────────────────────────────────────

    /**
     * Run a command, streaming stdout+stderr lines to onLine as they arrive.
     * Exit code and completion go to onDone. A PTY is requested so programs
     * that check isatty (sudo prompts, colored tools) behave.
     */
    fun exec(command: String, timeoutSec: Int, onLine: (String) -> Unit, onDone: (Int, String, Boolean) -> Unit) {
        Thread {
            val sess = synchronized(lock) { session?.takeIf { it.isConnected } }
            if (sess == null) { onDone(-1, "NOT_CONNECTED", true); return@Thread }
            var chan: ChannelExec? = null
            try {
                val c = sess.openChannel("exec") as ChannelExec
                chan = c
                c.setCommand(command)
                c.setPty(true)
                // PTY merges stderr into stdout; read the channel's input
                // stream directly until EOF (channel closed = stream EOF).
                val ins = c.inputStream
                c.connect(15_000)
                val reader = Thread {
                    try {
                        val buf = StringBuilder()
                        val b = ByteArray(8192)
                        while (true) {
                            val n = ins.read(b)
                            if (n < 0) break
                            for (i in 0 until n) {
                                val ch = b[i].toInt().toChar()
                                if (ch == '\n') {
                                    onLine(buf.toString()); buf.setLength(0)
                                } else if (ch != '\r') buf.append(ch)
                            }
                        }
                        if (buf.isNotEmpty()) onLine(buf.toString())
                    } catch (_: Exception) {}
                }
                reader.start()
                // Wait for the channel to close, bounded by the timeout.
                val deadline = System.currentTimeMillis() + timeoutSec * 1000L
                while (!c.isClosed && System.currentTimeMillis() < deadline) Thread.sleep(120)
                if (!c.isClosed) {
                    try { c.disconnect() } catch (_: Exception) {}
                    onLine("(timed out after ${timeoutSec}s — killed)")
                    onDone(-1, "TIMEOUT", true)
                    return@Thread
                }
                reader.join(3000)
                try { ins.close() } catch (_: Exception) {}
                onDone(c.exitStatus, "", false)
            } catch (e: Exception) {
                onDone(-1, e.message ?: e.toString(), true)
            } finally {
                try { chan?.disconnect() } catch (_: Exception) {}
            }
        }.start()
    }

    // ── SFTP file transfer ──────────────────────────────────────────────

    private fun withSftp(block: (ChannelSftp) -> Unit): Pair<String, Boolean> {
        val s = synchronized(lock) { session?.takeIf { it.isConnected } }
            ?: return Pair("NOT_CONNECTED", true)
        var ch: ChannelSftp? = null
        return try {
            val c = s.openChannel("sftp") as ChannelSftp
            ch = c
            c.connect(15_000)
            block(c)
            Pair("", false)
        } catch (e: SftpException) {
            Pair("SFTP_${e.id}: ${e.message}", true)
        } catch (e: Exception) {
            Pair(e.message ?: e.toString(), true)
        } finally {
            try { ch?.disconnect() } catch (_: Exception) {}
        }
    }

    /** Upload bytes from the connected project folder to a remote path. */
    fun upload(localPath: String, remotePath: String, onLine: (String) -> Unit, onDone: (Int, String, Boolean) -> Unit) {
        Thread {
            val bytes = readLocal(localPath)
            if (bytes == null) { onDone(-1, "LOCAL_FILE_NOT_FOUND: $localPath", true); return@Thread }
            onLine("Uploading ${bytes.size} bytes → $remotePath")
            val (err, fail) = withSftp { sftp ->
                mkdirp(sftp, remotePath.substringBeforeLast('/', ""))
                sftp.put(ByteArrayInputStream(bytes), remotePath, ChannelSftp.OVERWRITE)
            }
            if (fail) onDone(-1, err, true)
            else { onLine("Uploaded $localPath → $remotePath"); onDone(0, "UPLOADED", false) }
        }.start()
    }

    /** Download a remote file into the connected project folder. */
    fun download(remotePath: String, localPath: String, onLine: (String) -> Unit, onDone: (Int, String, Boolean) -> Unit) {
        Thread {
            val buf = java.io.ByteArrayOutputStream()
            val (err, fail) = withSftp { sftp -> sftp.get(remotePath, buf) }
            if (fail) { onDone(-1, err, true); return@Thread }
            val bytes = buf.toByteArray()
            onLine("Downloaded ${bytes.size} bytes from $remotePath")
            if (!writeLocal(localPath, bytes)) { onDone(-1, "WRITE_FAILED: $localPath", true); return@Thread }
            onDone(0, "DOWNLOADED", false)
        }.start()
    }

    /** Create every directory component of a remote path (sftp mkdir -p). */
    private fun mkdirp(sftp: ChannelSftp, dirPath: String) {
        if (dirPath.isBlank() || dirPath == "/") return
        var cur = if (dirPath.startsWith("/")) "" else null
        for (part in dirPath.split('/').filter { it.isNotBlank() }) {
            cur = if (cur == null) part else "$cur/$part"
            val path = if (dirPath.startsWith("/")) "/$cur" else cur
            try { sftp.cd(path) } catch (_: SftpException) { sftp.mkdir(path) }
        }
    }
}
