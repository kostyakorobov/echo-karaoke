package com.echo.karaoke

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    companion object {
        private val ROOMS = listOf("hall_1", "hall_2", "hall_3", "hall_4", "hall_5")
        private const val PREFS = "echo_karaoke"
        private const val KEY_ROOM = "selected_room"
        private const val BASE_URL = "https://echokaraoke.vercel.app/player"
    }

    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )

        // Intent extra wins (legacy ADB workflow + override). Also persists.
        val intentRoom = intent.getStringExtra("room")
        if (intentRoom != null) {
            saveRoom(intentRoom)
            loadPlayer(intentRoom)
            return
        }

        val savedRoom = getSavedRoom()
        if (savedRoom != null) {
            loadPlayer(savedRoom)
        } else {
            showPicker()
        }
    }

    private fun getSavedRoom(): String? =
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ROOM, null)

    private fun saveRoom(room: String) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ROOM, room)
            .apply()
    }

    private fun showPicker() {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0A0A0A.toInt())
            gravity = Gravity.CENTER
            setPadding(96, 96, 96, 96)
        }

        val title = TextView(this).apply {
            text = "ЭХО"
            textSize = 64f
            setTextColor(0xFFA855F7.toInt())
            gravity = Gravity.CENTER
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        }
        container.addView(title)

        val sub = TextView(this).apply {
            text = "Выберите зал на этой приставке"
            textSize = 22f
            setTextColor(0xFFA3A3A3.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 24, 0, 64)
        }
        container.addView(sub)

        val hint = TextView(this).apply {
            text = "Выбор сохраняется. Чтобы поменять зал — Настройки → Приложения → EchoKaraoke → Очистить данные."
            textSize = 14f
            setTextColor(0xFF525252.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 48, 0, 0)
        }

        for ((index, room) in ROOMS.withIndex()) {
            val btn = Button(this).apply {
                text = "Зал ${index + 1}"
                textSize = 28f
                setBackgroundColor(0xFF262626.toInt())
                setTextColor(0xFFFFFFFF.toInt())
                isFocusable = true
                isFocusableInTouchMode = true
                setOnClickListener {
                    saveRoom(room)
                    loadPlayer(room)
                }
            }
            val params = LinearLayout.LayoutParams(
                500,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = 16
                bottomMargin = 16
            }
            container.addView(btn, params)
            if (index == 0) btn.requestFocus()
        }

        container.addView(hint)
        setContentView(container)
    }

    private fun loadPlayer(room: String) {
        val wv = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowContentAccess = true
                loadWithOverviewMode = true
                useWideViewPort = true
            }
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
            loadUrl("$BASE_URL?room=$room")
        }
        webView = wv
        setContentView(wv)
    }

    @Suppress("MissingSuperCall")
    override fun onBackPressed() {
        webView?.let {
            if (it.canGoBack()) it.goBack()
        }
        // Don't call super — prevent exiting the app
    }
}
