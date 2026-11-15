package vn.peo.ccremote.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Lưu token thiết bị mã hoá bằng khoá AES-GCM trong Android Keystore (không cần thư viện security-crypto đã bị bỏ).
 * Keystore hỏng / thiếu thì rơi về lưu thường trong SharedPreferences của app (vẫn nằm trong sandbox) — giống
 * SecureStore.swift trên iOS. (= Storage.swift)
 */
object SecureStore {
    private const val ALIAS = "ccremote_hub_key"
    private const val PROVIDER = "AndroidKeyStore"
    private const val PREFIX_ENC = "enc."
    private const val PREFIX_PLAIN = "plain."
    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences("secure", Context.MODE_PRIVATE)
    }

    private fun key(): SecretKey? = try {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).run {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    } catch (_: Exception) {
        null
    }

    fun set(name: String, value: String?) {
        val e = prefs.edit().remove(PREFIX_ENC + name).remove(PREFIX_PLAIN + name)
        if (value != null) {
            val enc = try {
                key()?.let { k ->
                    val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, k) }
                    Base64.encodeToString(c.iv + c.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
                }
            } catch (_: Exception) {
                null
            }
            if (enc != null) e.putString(PREFIX_ENC + name, enc) else e.putString(PREFIX_PLAIN + name, value)
        }
        e.commit()
    }

    fun get(name: String): String? {
        prefs.getString(PREFIX_ENC + name, null)?.let { enc ->
            try {
                val raw = Base64.decode(enc, Base64.NO_WRAP)
                val c = Cipher.getInstance("AES/GCM/NoPadding").apply {
                    init(Cipher.DECRYPT_MODE, key() ?: return@let, GCMParameterSpec(128, raw, 0, 12))
                }
                return String(c.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
            } catch (_: Exception) {
                // khoá mất (xoá dữ liệu / khôi phục máy khác) -> coi như chưa đăng nhập
            }
        }
        return prefs.getString(PREFIX_PLAIN + name, null)
    }
}

/** Cài đặt thường (UserDefaults bên iOS). */
object Prefs {
    private lateinit var sp: SharedPreferences

    fun init(context: Context) {
        sp = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)
    }

    fun string(k: String, def: String? = null): String? = sp.getString(k, def)
    fun putString(k: String, v: String?) = sp.edit().apply { if (v == null) remove(k) else putString(k, v) }.apply()
    fun bool(k: String, def: Boolean = false): Boolean = sp.getBoolean(k, def)
    fun putBool(k: String, v: Boolean) = sp.edit().putBoolean(k, v).apply()

    fun doubles(k: String): Set<Double> = (sp.getString(k, "") ?: "").split(',').mapNotNull { it.toDoubleOrNull() }.toSet()
    fun putDoubles(k: String, v: Set<Double>) = sp.edit().putString(k, v.joinToString(",")).apply()

    var hubUrl: String
        get() = string("hubURL") ?: DEFAULT_HUB
        set(v) = putString("hubURL", v)
    var machineId: String
        get() = string("machineId") ?: ""
        set(v) = putString("machineId", v)

    /** bật thông báo trong app (iOS: notifyOn) */
    var notifyOn: Boolean
        get() = bool("notifyOn", true)
        set(v) = putBool("notifyOn", v)

    /** giữ kết nối nền bằng dịch vụ foreground (iOS: keepAlive) */
    var keepAlive: Boolean
        get() = bool("keepAlive", true)
        set(v) = putBool("keepAlive", v)
    var sendOriginal: Boolean
        get() = bool("sendOriginal", false)
        set(v) = putBool("sendOriginal", v)

    const val DEFAULT_HUB = "https://clauderc.caesarvn.xyz"
}
