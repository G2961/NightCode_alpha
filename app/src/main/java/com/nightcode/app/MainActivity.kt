package com.nightcode.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import java.net.HttpURLConnection
import java.net.URL
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.documentfile.provider.DocumentFile
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private var projectRoot: DocumentFile? = null
    private var projectName: String = ""
    private var workspaceRoot: DocumentFile? = null
    private var workspaceName: String = ""
    // When the active project is a subfolder of the workspace (not a separately
    // picked SAF tree), we persist just its name — restoring re-resolves it as a
    // child of workspaceRoot rather than needing its own tree permission.
    private var projectIsWorkspaceChild: Boolean = false

    /** SSH for the agent: connect/exec/upload/download over one persistent
     *  session. Reads/writes local files through the same SAF roots the fs
     *  bridge uses, so "upload src/main.py" just works against the project. */
    private val sshManager by lazy {
        SshManager(
            this,
            readLocal = { path -> readProjectBytes(path) },
            writeLocal = { path, bytes -> writeProjectBytes(path, bytes) }
        )
    }

    @Volatile private var activeRequests = 0
    private var wakeLock: PowerManager.WakeLock? = null

    /** Holds a partial wake lock while any HTTP request is in flight: Android
     * freezes backgrounded apps and kills their sockets/DNS mid-request, which
     * surfaced as "Unable to resolve host" after returning to the app. */
    private fun beginRequest() {
        synchronized(this) {
            activeRequests++
            if (activeRequests == 1) {
                try {
                    val pm = getSystemService(POWER_SERVICE) as PowerManager
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NightCode:http").apply {
                        setReferenceCounted(false)
                        acquire(10 * 60 * 1000L) // 10 min safety cap
                    }
                } catch (_: Exception) {}
            }
        }
    }

    private fun endRequest() {
        synchronized(this) {
            activeRequests--
            if (activeRequests <= 0) {
                activeRequests = 0
                try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
                wakeLock = null
            }
        }
    }

    @Volatile private var sysStatus = 0
    @Volatile private var sysNav = 0
    @Volatile private var sysIme = 0

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        // Restore previously granted folders (persistable URI permissions).
        // Workspace first: a workspace-child project resolves relative to it.
        restoreWorkspace()
        restoreProject()

        webView = WebView(this).apply {
            setBackgroundColor(0xFF090A0C.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            // The UI is loaded from file:///android_asset (origin "null"),
            // so without universal access the WebView blocks API calls via CORS.
            settings.allowUniversalAccessFromFileURLs = true
            settings.allowFileAccessFromFileURLs = true
            settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            settings.loadsImagesAutomatically = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            settings.displayZoomControls = false

            if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
                WebSettingsCompat.setForceDark(settings, WebSettingsCompat.FORCE_DARK_OFF)
            }

            addJavascriptInterface(AndroidBridge(), "Android")

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val url = request.url.toString()
                    return !(url.startsWith("http://") || url.startsWith("https://"))
                }

                override fun onPageFinished(view: WebView, url: String) {
                    // Insets may have arrived while about:blank was showing; re-apply
                    // them now that the real page can receive the CSS variables.
                    pushSysInsets()
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
                    Log.d("NightCodeJS", "${message.message()} (line ${message.lineNumber()})")
                    return true
                }
            }

            // The page handles its own scrolling (body is position:fixed); any native
            // pan gesture here would drag the whole layout, so swallow it.
            setOnTouchListener { v, _ ->
                v.performClick()
                false
            }
        }

        setContentView(webView)

        // env(safe-area-inset-*) is always 0 inside an Android WebView, and Chromium
        // does not reliably re-layout its viewport from native view padding either.
        // So insets are forwarded into the page as CSS variables; the stylesheet
        // positions .topbar and .composer-wrap from them. The listener re-fires on
        // IME show/hide, which is what lifts the composer above the keyboard.
        // Native setPadding is intentionally NOT used: applying both would double
        // the offset wherever the native path does work.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
            // Split insets: displayCutout OR statusBars can double-count on some
            // devices, and nav bar + IME must never be summed — the composer takes
            // whichever is larger (see margin-bottom:max() in style.css).
            sysStatus = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top
            sysNav = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
            sysIme = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            pushSysInsets()
            insets
        }
        // Insets can arrive before the first layout pass dispatches them; force it.
        ViewCompat.requestApplyInsets(webView)
        webView.loadUrl("file:///android_asset/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    override fun onDestroy() {
        try { sshManager.disconnect { _, _, _ -> } } catch (_: Exception) {}
        webView.removeJavascriptInterface("Android")
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }

    private fun pushSysInsets() {
        // WindowInsets arrive in physical pixels, but CSS pixels in the WebView are
        // density-independent. Without this conversion every offset renders ~2.6x
        // too large on a Pixel 6 (density 2.625).
        val density = resources.displayMetrics.density
        val cssStatus = (sysStatus / density).toInt()
        val cssNav = (sysNav / density).toInt()
        val cssIme = (sysIme / density).toInt()
        webView.evaluateJavascript(
            "document.documentElement.style.setProperty('--sys-status','${cssStatus}px');" +
                "document.documentElement.style.setProperty('--sys-nav','${cssNav}px');" +
                "document.documentElement.style.setProperty('--sys-ime','${cssIme}px');" +
                // CSS var writes don't reliably fire resize/visualViewport events in
                // this WebView, which is why keyboard-open scroll compensation only
                // ever kicked in on the SECOND toggle. Nudge it directly, after the
                // new inset has actually been applied to layout (two rAFs: one for
                // style recalc, one for the resulting reflow).
                "requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__syncKeyboard&&window.__syncKeyboard()}));",
            null
        )
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_OPEN_TREE -> {
                // Only treat as connected when the user actually picked a folder.
                val uri = data?.data
                if (resultCode == RESULT_OK && uri != null) {
                    try {
                        contentResolver.takePersistableUriPermission(
                            uri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        )
                    } catch (_: SecurityException) {}
                    projectRoot = DocumentFile.fromTreeUri(this, uri)
                    projectName = projectRoot?.name ?: "project"
                    projectIsWorkspaceChild = false
                    saveProject(uri)
                }
                val name = if (projectRoot != null) jsonString(projectName) else "null"
                js("window.__onProjectPicked && window.__onProjectPicked($name)")
            }
            REQ_OPEN_WORKSPACE -> {
                val uri = data?.data
                if (resultCode == RESULT_OK && uri != null) {
                    try {
                        contentResolver.takePersistableUriPermission(
                            uri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        )
                    } catch (_: SecurityException) {}
                    workspaceRoot = DocumentFile.fromTreeUri(this, uri)
                    workspaceName = workspaceRoot?.name ?: "workspace"
                    saveWorkspace(uri)
                }
                val name = if (workspaceRoot != null) jsonString(workspaceName) else "null"
                js("window.__onWorkspacePicked && window.__onWorkspacePicked($name)")
            }
            REQ_OPEN_FILES -> {
                val files = mutableListOf<String>()
                if (resultCode == RESULT_OK && data != null) {
                    val uris = mutableListOf<Uri>()
                    data.data?.let { uris.add(it) }
                    data.clipData?.let { clip ->
                        for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
                    }
                    for (u in uris) {
                        try {
                            val name = queryDisplayName(u) ?: "file"
                            base64InputStream(u)?.let { b64 ->
                                files.add("{\"name\":" + jsonString(name) + ",\"b64\":\"$b64\"}")
                            }
                        } catch (_: Exception) {}
                    }
                }
                js("window.__onFilesPicked && window.__onFilesPicked([" + files.joinToString(",") + "])")
            }
        }
    }

    private fun base64InputStream(uri: Uri): String? = try {
        contentResolver.openInputStream(uri)?.use { ins ->
            Base64.encodeToString(ins.readBytes(), Base64.NO_WRAP)
        }
    } catch (_: Exception) { null }

    private fun js(code: String) {
        webView.post { webView.evaluateJavascript(code) {} }
    }

    private fun saveProject(uri: Uri) {
        getSharedPreferences("nightcode", MODE_PRIVATE)
            .edit()
            .putString("projectUri", uri.toString())
            .putString("projectName", projectName)
            .remove("projectWorkspaceChild")
            .apply()
    }

    private fun restoreProject() {
        val prefs = getSharedPreferences("nightcode", MODE_PRIVATE)
        val childName = prefs.getString("projectWorkspaceChild", null)
        if (childName != null) {
            val ws = workspaceRoot
            val child = ws?.findFile(childName)?.takeIf { it.isDirectory }
            if (child != null) {
                projectRoot = child
                projectName = childName
                projectIsWorkspaceChild = true
                return
            }
            // Workspace or the subfolder is gone — fall through and clear state
            // rather than silently resolving to nothing.
            prefs.edit().remove("projectWorkspaceChild").remove("projectUri").remove("projectName").apply()
            return
        }
        restoreFolder("projectUri", "projectName") { root, name ->
            projectRoot = root
            projectName = name
            projectIsWorkspaceChild = false
        }
    }

    /** Switch the active project to a subfolder of the workspace — no new SAF
     * grant needed since the workspace tree permission already covers it. */
    private fun saveWorkspaceChildProject(name: String) {
        projectIsWorkspaceChild = true
        getSharedPreferences("nightcode", MODE_PRIVATE)
            .edit()
            .putString("projectWorkspaceChild", name)
            .remove("projectUri")
            .remove("projectName")
            .apply()
    }

    private fun saveWorkspace(uri: Uri) {
        getSharedPreferences("nightcode", MODE_PRIVATE)
            .edit()
            .putString("workspaceUri", uri.toString())
            .putString("workspaceName", workspaceName)
            .apply()
    }

    private fun restoreWorkspace() {
        restoreFolder("workspaceUri", "workspaceName") { root, name ->
            workspaceRoot = root
            workspaceName = name
        }
    }

    private inline fun restoreFolder(uriKey: String, nameKey: String, assign: (DocumentFile?, String) -> Unit) {
        val prefs = getSharedPreferences("nightcode", MODE_PRIVATE)
        val saved = prefs.getString(uriKey, null) ?: return
        try {
            val uri = Uri.parse(saved)
            val persisted = contentResolver.persistedUriPermissions.any {
                it.uri == uri && it.isReadPermission
            }
            if (!persisted) return
            val root = DocumentFile.fromTreeUri(this, uri)
            assign(root, prefs.getString(nameKey, "") ?: (root?.name ?: ""))
        } catch (_: Exception) {
            assign(null, "")
        }
    }

    private fun jsonString(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> if (c.code < 0x20) sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
        }
        return sb.append("\"").toString()
    }

    private fun queryDisplayName(uri: Uri): String? {
        try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (idx >= 0 && c.moveToFirst()) return c.getString(idx)
            }
        } catch (_: Exception) {}
        return uri.lastPathSegment
    }

    /* ── File system bridge: runs on a worker thread, returns result to JS ── */

    private fun fsCallback(cb: String, result: String, error: Boolean) {
        val payload = jsonString(result)
        js("window.__fsResult && window.__fsResult(${jsonString(cb)}, $payload, $error)")
    }

    private fun runFs(op: String, a: String, b: String, cb: String) {
        val root = projectRoot
        if (root == null && workspaceRoot == null) {
            fsCallback(cb, "NO_PROJECT", true)
            return
        }
        // Paths prefixed with "workspace:" address the permanent workspace folder;
        // everything else goes to the current project folder.
        val useWorkspace = a.startsWith("workspace:") || b.startsWith("workspace:")
        val target = if (useWorkspace) workspaceRoot else (root ?: workspaceRoot)
        if (target == null) {
            fsCallback(cb, "NO_PROJECT", true)
            return
        }
        val path = if (useWorkspace) a.removePrefix("workspace:") else a
        val pathB = if (b.startsWith("workspace:")) b.removePrefix("workspace:") else b
        Thread {
            var result = ""
            var error = false
            try {
                when (op) {
                    "list" -> {
                        // Optional subpath (e.g. "extensions" inside the workspace)
                        // lets JS enumerate a single folder instead of the whole tree.
                        val start = if (path.isEmpty()) target
                            else target.findFileRecursive(path)?.takeIf { it.isDirectory }
                                ?: throw Exception("DIR_NOT_FOUND")
                        val names = mutableListOf<String>()
                        walkFiles(start) { _, rel -> if (names.size < 500) names.add(rel) }
                        result = names.joinToString("\n").ifEmpty { "EMPTY_PROJECT" }
                    }
                    "read" -> {
                        val f = target.findFileRecursive(path)
                        if (f == null) throw Exception("FILE_NOT_FOUND")
                        val bytes = contentResolver.openInputStream(f.uri)?.use { it.readBytes() }
                        if (bytes == null) throw Exception("READ_FAILED")
                        result = String(bytes, Charsets.UTF_8)
                    }
                    "write" -> {
                        val name = path.substringAfterLast('/')
                        val dir = resolveDir(target, path.substringBeforeLast('/', ""), create = true)
                        if (dir == null) throw Exception("WRITE_FAILED")
                        val targetFile = dir.findFile(name)
                            ?: dir.createFile("application/octet-stream", name)
                        if (targetFile == null) throw Exception("WRITE_FAILED")
                        val out = contentResolver.openOutputStream(targetFile.uri, "wt")
                        if (out == null) throw Exception("WRITE_FAILED")
                        out.use { it.write(Base64.decode(b, Base64.NO_WRAP)) }
                        result = "WROTE $path"
                    }
                    "search" -> {
                        val q = path.lowercase()
                        val hits = mutableListOf<String>()
                        walkFiles(target) { file, rel ->
                            if (hits.size < 100 && file.length() in 1..2_000_000) {
                                try {
                                    val text = contentResolver.openInputStream(file.uri)
                                        ?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                                    if (text.lowercase().contains(q)) hits.add(rel)
                                } catch (_: Exception) {}
                            }
                        }
                        result = hits.joinToString("\n").ifEmpty { "NO_MATCHES" }
                    }
                    "mkdir" -> {
                        if (resolveDir(target, path, create = true) == null) throw Exception("MKDIR_FAILED")
                        result = "CREATED_DIRECTORY $path"
                    }
                    "rename" -> {
                        // SAF rename is unreliable across providers: move = copy + delete.
                        val src = target.findFileRecursive(path) ?: throw Exception("FILE_NOT_FOUND")
                        val bytes = contentResolver.openInputStream(src.uri)?.use { it.readBytes() }
                            ?: throw Exception("RENAME_FAILED")
                        val dir = resolveDir(target, pathB.substringBeforeLast('/', ""), create = true)
                        if (dir == null) throw Exception("RENAME_FAILED")
                        val targetName = pathB.substringAfterLast('/')
                        val existing = dir.findFile(targetName)
                        if (existing != null && !existing.delete()) throw Exception("RENAME_FAILED")
                        val dest = dir.createFile("application/octet-stream", targetName)
                            ?: throw Exception("RENAME_FAILED")
                        val out = contentResolver.openOutputStream(dest.uri, "wt")
                            ?: throw Exception("RENAME_FAILED")
                        out.use { it.write(bytes) }
                        if (!src.delete()) throw Exception("RENAME_FAILED")
                        result = "RENAMED $path -> $pathB"
                    }
                    "delete" -> {
                        val f = target.findFileRecursive(path) ?: throw Exception("FILE_NOT_FOUND")
                        if (!f.delete()) throw Exception("DELETE_FAILED")
                        result = "DELETED $path"
                    }
                    else -> throw Exception("UNKNOWN_OP")
                }
            } catch (e: Exception) {
                result = e.message ?: "ERROR"
                error = true
            }
            fsCallback(cb, result, error)
        }.start()
    }

    private fun walkFiles(root: DocumentFile, visit: (DocumentFile, String) -> Unit) {
        fun rec(dir: DocumentFile, prefix: String, depth: Int) {
            if (depth > 6) return
            val entries = try { dir.listFiles() } catch (_: Exception) { return }
            for (f in entries) {
                val name = f.name ?: continue
                if (f.isDirectory) {
                    val rel = if (prefix.isEmpty()) name else "$prefix/$name"
                    visit(f, "$rel/")
                    rec(f, rel, depth + 1)
                } else {
                    visit(f, if (prefix.isEmpty()) name else "$prefix/$name")
                }
            }
        }
        rec(root, "", 0)
    }

    private fun resolveDir(root: DocumentFile, path: String, create: Boolean): DocumentFile? {
        var dir = root
        for (part in path.split('/').filter { it.isNotBlank() }) {
            val next = dir.findFile(part)?.takeIf { it.isDirectory }
                ?: if (create) dir.createDirectory(part) else null
            if (next == null) return null
            dir = next
        }
        return dir
    }

    private fun DocumentFile.findFileRecursive(path: String): DocumentFile? {
        val parts = path.split('/').filter { it.isNotBlank() }
        if (parts.isEmpty()) return null
        var dir = this
        for (i in 0 until parts.size - 1) {
            dir = dir.findFile(parts[i])?.takeIf { it.isDirectory } ?: return null
        }
        return dir.findFile(parts.last())
    }

    /* ── SSH local-file helpers (same "workspace:" routing as runFs) ── */

    private fun sshLocalRoot(path: String): DocumentFile? {
        if (path.startsWith("workspace:")) return workspaceRoot
        return projectRoot ?: workspaceRoot
    }

    private fun readProjectBytes(rawPath: String): ByteArray? = try {
        val root = sshLocalRoot(rawPath) ?: return null
        val path = if (rawPath.startsWith("workspace:")) rawPath.removePrefix("workspace:") else rawPath
        val f = root.findFileRecursive(path) ?: return null
        contentResolver.openInputStream(f.uri)?.use { it.readBytes() }
    } catch (_: Exception) { null }

    private fun writeProjectBytes(rawPath: String, bytes: ByteArray): Boolean = try {
        val root = sshLocalRoot(rawPath) ?: return false
        val path = if (rawPath.startsWith("workspace:")) rawPath.removePrefix("workspace:") else rawPath
        val name = path.substringAfterLast('/')
        val dir = resolveDir(root, path.substringBeforeLast('/', ""), create = true) ?: return false
        val targetFile = dir.findFile(name) ?: dir.createFile("application/octet-stream", name) ?: return false
        contentResolver.openOutputStream(targetFile.uri, "wt")?.use { it.write(bytes) } != null
    } catch (_: Exception) { false }

    inner class AndroidBridge {
        // cb id -> live connection, so a stream can be aborted from JS mid-flight.
        private val activeStreams = java.util.concurrent.ConcurrentHashMap<String, HttpURLConnection>()

        @JavascriptInterface
        fun openFilePicker() {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            startActivityForResult(intent, REQ_OPEN_FILES)
        }

        @JavascriptInterface
        fun openProjectPicker() {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            startActivityForResult(intent, REQ_OPEN_TREE)
        }

        @JavascriptInterface
        fun openWorkspacePicker() {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            startActivityForResult(intent, REQ_OPEN_WORKSPACE)
        }

        @JavascriptInterface
        fun hasProject(): Boolean = projectRoot != null

        @JavascriptInterface
        fun getProjectName(): String = if (projectRoot != null) projectName else ""

        @JavascriptInterface
        fun hasWorkspace(): Boolean = workspaceRoot != null

        @JavascriptInterface
        fun getWorkspaceName(): String = if (workspaceRoot != null) workspaceName else ""

        @JavascriptInterface
        fun clearWorkspace() {
            workspaceRoot = null
            workspaceName = ""
            val prefs = getSharedPreferences("nightcode", MODE_PRIVATE)
            // A workspace-child project has no independent tree permission —
            // it goes away with the workspace that granted it.
            if (projectIsWorkspaceChild) {
                projectRoot = null
                projectName = ""
                projectIsWorkspaceChild = false
                prefs.edit().remove("projectWorkspaceChild").apply()
            }
            prefs.edit().remove("workspaceUri").remove("workspaceName").apply()
        }

        @JavascriptInterface
        fun clearProject() {
            projectRoot = null
            projectName = ""
            projectIsWorkspaceChild = false
            getSharedPreferences("nightcode", MODE_PRIVATE).edit()
                .remove("projectUri").remove("projectName").remove("projectWorkspaceChild").apply()
        }

        /** Top-level subfolders of the workspace — the project list. One name per line. */
        @JavascriptInterface
        fun listWorkspaceProjects(cb: String) {
            val ws = workspaceRoot
            if (ws == null) { fsCallback(cb, "NO_WORKSPACE", true); return }
            Thread {
                try {
                    val names = ws.listFiles().filter { it.isDirectory }.mapNotNull { it.name }.sorted()
                    fsCallback(cb, names.joinToString("\n"), false)
                } catch (e: Exception) {
                    fsCallback(cb, e.message ?: "LIST_FAILED", true)
                }
            }.start()
        }

        /** Make an existing workspace subfolder the active project. */
        @JavascriptInterface
        fun switchWorkspaceProject(name: String, cb: String) {
            val ws = workspaceRoot
            if (ws == null) { fsCallback(cb, "NO_WORKSPACE", true); return }
            Thread {
                val child = ws.findFile(name)?.takeIf { it.isDirectory }
                if (child == null) { fsCallback(cb, "NOT_FOUND", true); return@Thread }
                projectRoot = child
                projectName = name
                saveWorkspaceChildProject(name)
                fsCallback(cb, name, false)
            }.start()
        }

        /** Create a new subfolder under the workspace and switch to it. */
        @JavascriptInterface
        fun createWorkspaceProject(name: String, cb: String) {
            val ws = workspaceRoot
            if (ws == null) { fsCallback(cb, "NO_WORKSPACE", true); return }
            Thread {
                try {
                    if (ws.findFile(name) != null) throw Exception("ALREADY_EXISTS")
                    val dir = ws.createDirectory(name) ?: throw Exception("CREATE_FAILED")
                    projectRoot = dir
                    projectName = name
                    saveWorkspaceChildProject(name)
                    fsCallback(cb, name, false)
                } catch (e: Exception) {
                    fsCallback(cb, e.message ?: "CREATE_FAILED", true)
                }
            }.start()
        }

        @JavascriptInterface
        fun fsList(path: String, cb: String) { runFs("list", path, "", cb) }

        @JavascriptInterface
        fun fsRead(path: String, cb: String) { runFs("read", path, "", cb) }

        @JavascriptInterface
        fun fsWrite(path: String, contentB64: String, cb: String) { runFs("write", path, contentB64, cb) }

        @JavascriptInterface
        fun fsSearch(query: String, cb: String) { runFs("search", query, "", cb) }

        @JavascriptInterface
        fun fsMkdir(path: String, cb: String) { runFs("mkdir", path, "", cb) }

        @JavascriptInterface
        fun fsRename(from: String, to: String, cb: String) { runFs("rename", from, to, cb) }

        @JavascriptInterface
        fun fsDelete(path: String, cb: String) { runFs("delete", path, "", cb) }

        /* ── SSH bridge: connect / exec / upload / download ──
         * Output streams to JS line by line via window.__sshData(cbId, line),
         * completion via window.__sshDone(cbId, code, message, error) — same
         * shape as the SSE stream callbacks above. */

        private fun sshCallback(cb: String, code: Int, msg: String, error: Boolean) {
            js("window.__sshDone && window.__sshDone(${jsonString(cb)}, $code, ${jsonString(msg)}, $error)")
        }

        private fun sshLine(cb: String, line: String) {
            js("window.__sshData && window.__sshData(${jsonString(cb)}, ${jsonString(line)})")
        }

        /** paramsJson: {host,port,user,password,privateKeyB64,passphrase,save}; empty = reconnect saved */
        @JavascriptInterface
        fun sshConnect(paramsJson: String, cb: String) {
            beginRequest()
            sshManager.connect(paramsJson,
                onLine = { sshLine(cb, it) },
                onDone = { code, msg, err -> sshCallback(cb, code, msg, err); endRequest() })
        }

        @JavascriptInterface
        fun sshDisconnect(cb: String) {
            sshManager.disconnect { code, msg, err -> sshCallback(cb, code, msg, err) }
        }

        @JavascriptInterface
        fun sshIsConnected(): Boolean = sshManager.isConnected

        /** Streams output lines to JS as they arrive; auto-reconnects saved session if dead. */
        @JavascriptInterface
        fun sshExec(command: String, timeoutSec: Int, cb: String) {
            beginRequest()
            if (!sshManager.isConnected) {
                // Auto-reconnect with saved credentials, then run.
                sshManager.connect("",
                    onLine = {},
                    onDone = { code, msg, err ->
                        if (err) { sshCallback(cb, code, msg, err); endRequest() }
                        else sshManager.exec(command, timeoutSec,
                            onLine = { sshLine(cb, it) },
                            onDone = { c2, m2, e2 -> sshCallback(cb, c2, m2, e2); endRequest() })
                    })
            } else {
                sshManager.exec(command, timeoutSec,
                    onLine = { sshLine(cb, it) },
                    onDone = { code, msg, err -> sshCallback(cb, code, msg, err); endRequest() })
            }
        }

        @JavascriptInterface
        fun sshUpload(localPath: String, remotePath: String, cb: String) {
            beginRequest()
            sshManager.upload(localPath, remotePath,
                onLine = { sshLine(cb, it) },
                onDone = { code, msg, err -> sshCallback(cb, code, msg, err); endRequest() })
        }

        @JavascriptInterface
        fun sshDownload(remotePath: String, localPath: String, cb: String) {
            beginRequest()
            sshManager.download(remotePath, localPath,
                onLine = { sshLine(cb, it) },
                onDone = { code, msg, err -> sshCallback(cb, code, msg, err); endRequest() })
        }

        /** Saved SSH config for the settings UI: {host,port,user} or null. */
        @JavascriptInterface
        fun sshSavedHost(): String = sshManager.savedConfig() ?: ""

        /** Forget saved credentials and drop the session. */
        @JavascriptInterface
        fun sshForget() { sshManager.clearConfig() }

        /**
         * Streaming SSE variant: reads text/event-stream line by line and forwards
         * each data: payload to window.__streamChunk(cbId, data). Ends with
         * window.__streamDone(cbId, status, error).
         */
        @JavascriptInterface
        fun httpStream(method: String, url: String, headersJson: String, body: String, cb: String) {
            beginRequest()
            Thread {
                var code = 0
                var error = false
                var errMsg = ""
                var cancelled = false
                try {
                    val conn = URL(url).openConnection() as HttpURLConnection
                    activeStreams[cb] = conn
                    conn.requestMethod = method.uppercase()
                    conn.connectTimeout = 30000
                    conn.readTimeout = 600000
                    try {
                        val hdrs = org.json.JSONObject(headersJson)
                        for (key in hdrs.keys()) conn.setRequestProperty(key, hdrs.getString(key))
                    } catch (_: Exception) {}
                    if (conn.getRequestProperty("User-Agent").isNullOrEmpty()) {
                        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android 14; Mobile) Gecko/537.36 Chrome/127.0.0.0 Mobile Safari/537.36")
                    }
                    if (body.isNotEmpty()) {
                        conn.doOutput = true
                        val bytes = body.toByteArray(Charsets.UTF_8)
                        conn.setFixedLengthStreamingMode(bytes.size)
                        conn.outputStream.use { it.write(bytes) }
                    }
                    code = conn.responseCode
                    if (code in 200..399) {
                        val reader = java.io.BufferedReader(java.io.InputStreamReader(conn.inputStream, Charsets.UTF_8))
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty() || !line.startsWith("data:")) continue
                            val data = line.substring(5).trim()
                            js("window.__streamChunk && window.__streamChunk(${jsonString(cb)}, ${jsonString(data)})")
                        }
                    } else {
                        errMsg = conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                    }
                } catch (e: Exception) {
                    cancelled = activeStreams[cb] == null
                    errMsg = if (cancelled) "cancelled" else (e.message ?: e.toString())
                    error = !cancelled
                } finally {
                    activeStreams.remove(cb)
                }
                js("window.__streamDone && window.__streamDone(${jsonString(cb)}, $code, ${jsonString(errMsg)}, $error, $cancelled)")
                endRequest()
            }.start()
        }

        /** Cancel an in-flight httpStream by its callback id (aborts the socket read). */
        @JavascriptInterface
        fun httpStreamCancel(cb: String) {
            activeStreams.remove(cb)?.disconnect()
        }


        @JavascriptInterface
        fun openUrl(url: String) {
            if (url.startsWith("https://") || url.startsWith("http://")) {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            }
        }

        /**
         * Native HTTP for the page: the WebView origin is file:// ("null"), which API
         * servers reject via CORS. HttpURLConnection speaks no CORS, sends no Origin
         * and no preflight, so any Base URL works without a proxy.
         */
        @JavascriptInterface
        fun httpRequest(method: String, url: String, headersJson: String, body: String, cb: String) {
            beginRequest()
            Thread {
                var code = 0
                var respBody = ""
                var error = false
                try {
                    val conn = URL(url).openConnection() as HttpURLConnection
                    conn.requestMethod = method.uppercase()
                    conn.connectTimeout = 30000
                    // LLM generations can take minutes — generous read timeout.
                    conn.readTimeout = 600000
                    conn.instanceFollowRedirects = true
                    try {
                        val hdrs = org.json.JSONObject(headersJson)
                        for (key in hdrs.keys()) conn.setRequestProperty(key, hdrs.getString(key))
                    } catch (_: Exception) {}
                    // Cloudflare-protected hosts (ollama.com etc.) reject the default
                    // Dalvik User-Agent with 403. Always send a browser UA unless the
                    // caller set one explicitly.
                    if (conn.getRequestProperty("User-Agent").isNullOrEmpty()) {
                        conn.setRequestProperty(
                            "User-Agent",
                            "Mozilla/5.0 (Android 14; Mobile) Gecko/537.36 Chrome/127.0.0.0 Mobile Safari/537.36"
                        )
                    }
                    // Keep the transport simple: no transparent gzip to decode.
                    if (conn.getRequestProperty("Accept-Encoding") == null) {
                        conn.setRequestProperty("Accept-Encoding", "identity")
                    }
                    if (body.isNotEmpty()) {
                        conn.doOutput = true
                        val bytes = body.toByteArray(Charsets.UTF_8)
                        conn.setFixedLengthStreamingMode(bytes.size)
                        conn.outputStream.use { it.write(bytes) }
                    }
                    code = conn.responseCode
                    val stream = if (code in 200..399) conn.inputStream else conn.errorStream
                    respBody = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                } catch (e: Exception) {
                    respBody = e.message ?: e.toString()
                    error = true
                }
                val payload = jsonString(respBody)
                js("window.__httpResult && window.__httpResult(${jsonString(cb)}, $code, $payload, $error)")
                endRequest()
            }.start()
        }
    }

    companion object {
        private const val REQ_OPEN_TREE = 1002
        private const val REQ_OPEN_WORKSPACE = 1003
        private const val REQ_OPEN_FILES = 1001
    }
}
